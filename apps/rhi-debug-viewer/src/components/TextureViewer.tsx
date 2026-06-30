// TextureViewer.tsx — texture viewer panel: thumbnail strip + real rendered preview.
//
// Absorbs the former RtPanel: the main preview area mounts a live <canvas> and, on
// thumbnail selection, renders ACTUAL pixels (not placeholder text):
//   - Color RT  -> ensureReplaySession + commitThroughDraw + renderRtToCanvas (the
//     proven RT readback flow; this is what reconnects the browser smoke's
//     data-forgeax-rt-status / data-forgeax-rt-canvas anchors to the live layout).
//   - Depth (copyable: depth32float / depth16unorm) -> readbackDepthTexture +
//     normalizeDepth -> grayscale putImageData.
//   - Depth (non-copyable: depth24plus*) -> honest message: WebGPU forbids
//     copyTextureToBuffer on these formats; re-capture with depth32float to preview.
//   - Bound textures -> previewed when array-sliceable (2d / 2d-array / cube /
//     cube-array) and either any uncompressed color format (decoded to RGBA8 on the
//     host by decodeToRgba8 — any channels/bit-width, floats clamped to [0,1]) or any
//     depth format (grayscale via readbackDepthAuto). cube/array textures get a
//     per-slice selector (baseArrayLayer); compressed (BC/ETC/ASTC) and 3d fall back
//     to an honest message.
//   - A zoom toolbar (Fit / 1:1 / +/- ladder / percentage input) scales the preview;
//     magnification is pixelated so 1x1 / small textures blow up crisp.
//
// Status anchor values (data-forgeax-rt-status): ok | no-rt | no-webgpu | error.
//
// Related: requirements AC-06/AC-16/AC-18/AC-26; plan-strategy D-4/D-5.

/// <reference types="@webgpu/types" />

import type { RhiCallEvent } from '@forgeax/engine-rhi-debug';
import {
  bytesPerTexel,
  formatInfo,
  readbackTexturePixels,
  resolveTextureDescriptor,
} from '@forgeax/engine-rhi-debug';
import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import { normalizeDepth } from '../depth-normalize';
import { ensureReplaySession } from '../replay-session';
import { useSelection } from '../selection-context';
import type { RtStatus } from '../selectors';
import {
  rtCanvasAnchor,
  rtStatusAnchor,
  textureSliceAnchor,
  textureThumbnailAnchor,
  textureViewerAnchor,
  textureZoomAnchor,
} from '../selectors';
import { decodeToRgba8 } from '../texel-decode';
import {
  isDepthFormat,
  readbackDepthAuto,
  readbackStencilTexture,
  resolveDepthTextureDescriptor,
} from '../texture-readback';
import type { TextureDescriptor, TextureStatusEntry } from '../texture-status';
import { computeTextureStatus } from '../texture-status';
import { useTape, useViewModel } from '../viewer-context';
import type { DrawEntry, ViewModel } from '../viewer-model';

/** A thumbnail entry representing one texture attached to the selected draw. */
interface ThumbnailEntry {
  readonly handleId: string;
  readonly label: string;
  readonly format: string;
  readonly kind: 'color-rt' | 'depth' | 'stencil' | 'bound-texture';
  readonly status: TextureStatusEntry;
  /** Texture/view dimension ('2d' | 'cube' | ...); set for bound textures to gate preview. */
  readonly dimension?: string;
  /** Source texture's depthOrArrayLayers; drives the slice selector for cube/array textures. */
  readonly arrayLayers?: number;
}

/** True when a depth format carries a stencil plane (which IS copyable via aspect:'stencil-only'). */
function hasStencil(format: string): boolean {
  return format.includes('stencil8');
}

// Array-sliceable dimensions: each slice is an independent 2D image selected via
// baseArrayLayer. '3d' is excluded (its depth slices are not array layers and the
// readback path does not select them); cube/cube-array/2d-array all qualify.
const SLICEABLE_DIMENSIONS = new Set(['2d', '2d-array', 'cube', 'cube-array']);

// Cube face order matches cubeArrayDepthFaceView (packages/rhi): +X/-X/+Y/-Y/+Z/-Z.
const CUBE_FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;

/** Number of previewable slices for a texture: cube=6, cube-array/2d-array=layers, else 1. */
function sliceCount(dimension: string, arrayLayers: number): number {
  if (dimension === 'cube') return 6;
  if (dimension === 'cube-array' || dimension === '2d-array') return Math.max(1, arrayLayers);
  return 1;
}

/** Human label for one slice: face-aware for cube types, "Layer N" for 2d-array. */
function sliceLabel(dimension: string, slice: number): string {
  if (dimension === 'cube' || dimension === 'cube-array') {
    const face = CUBE_FACE_NAMES[slice % 6] ?? '?';
    return dimension === 'cube' ? `${face}` : `L${Math.floor(slice / 6)} ${face}`;
  }
  return `Layer ${slice}`;
}

// A bound texture is previewable when its selected slice (a 2D image) is either an
// uncompressed color format (any channels/bit-width — decoded on the host by
// decodeToRgba8) or ANY depth format (grayscale via readbackDepthAuto), and its
// dimension is array-sliceable (2d / 2d-array / cube / cube-array). cube/array
// textures preview one slice at a time via baseArrayLayer. Compressed (BC/ETC/ASTC),
// 3d, and depth/stencil have no formatInfo entry -> fall back to an honest message.
function isBoundPreviewable(dimension: string, format: string): boolean {
  if (!SLICEABLE_DIMENSIONS.has(dimension)) return false;
  return formatInfo(format) !== undefined || isDepthFormat(format);
}

function collectThumbnails(
  draw: DrawEntry,
  events: readonly RhiCallEvent[],
): readonly ThumbnailEntry[] {
  const entries: ThumbnailEntry[] = [];

  // Color RT
  if (draw.colorAttachmentHandleId !== undefined) {
    entries.push({
      handleId: draw.colorAttachmentHandleId,
      label: 'Color RT 0',
      format: 'rgba8unorm',
      kind: 'color-rt',
      status: { handleId: draw.colorAttachmentHandleId, status: 'ok', format: 'rgba8unorm' },
    });
  }

  // Depth-stencil. Read the real attachment format from pipelineState so a
  // non-copyable depth format degrades through computeTextureStatus (AC-18).
  if (draw.depthStencil.depthStencilViewHandleId !== undefined) {
    const depthFormat = draw.pipelineState.depthStencil.format;
    const dsHandle = draw.depthStencil.depthStencilViewHandleId;
    entries.push({
      handleId: dsHandle,
      label: 'Depth',
      format: depthFormat,
      kind: 'depth',
      status: { handleId: dsHandle, status: 'ok', format: depthFormat },
    });
    // A combined depth-stencil format exposes a separately previewable stencil
    // plane (stencil8 IS copyable even when the depth plane is not).
    if (hasStencil(depthFormat)) {
      entries.push({
        handleId: dsHandle,
        label: 'Stencil',
        format: depthFormat,
        kind: 'stencil',
        status: { handleId: dsHandle, status: 'ok', format: depthFormat },
      });
    }
  }

  // Bound textures from bindings. Resolve the real createTexture descriptor so the
  // strip shows the true format (not a hard-coded 'unknown') and the preview path can
  // decide previewability from format + dimension.
  const seen = new Set<string>();
  for (const binding of draw.bindings) {
    if (binding.kind === 'texture' || binding.kind === 'textureView') {
      const handleId = binding.handleId;
      if (!seen.has(handleId)) {
        seen.add(handleId);
        const desc = resolveTextureDescriptor(events, handleId);
        const format = desc?.format ?? 'unknown';
        entries.push({
          handleId,
          label: `Texture ${handleId}`,
          format,
          kind: 'bound-texture',
          status: { handleId, status: 'ok', format },
          dimension: desc?.dimension ?? '2d',
          arrayLayers: desc?.arrayLayers ?? 1,
        });
      }
    }
  }

  // Apply per-texture status matrix. Depth + stencil are now always previewable
  // (depth24plus depth plane via the sampling blit, stencil plane via stencil-only
  // copy), so they keep their 'ok' badge and bypass computeTextureStatus's
  // copyability-based 'error' downgrade (which only flagged depth24plus*).
  const descriptors: readonly TextureDescriptor[] = entries.map((e) => ({
    handleId: e.handleId,
    format: e.format,
  }));
  const statuses = computeTextureStatus(descriptors, true);
  return entries.map((e, i) => {
    if (e.kind === 'depth' || e.kind === 'stencil') return e;
    const st = statuses[i];
    return st ? { ...e, status: st } : e;
  });
}

/**
 * Optimistic status the panel shows synchronously before the async replay
 * resolves — mirrors the former RtPanel.deriveStatus so the data-forgeax-rt-status
 * anchor reads a meaningful value immediately (consumers poll the canvas pixels
 * for the real-paint confirmation). Color RT / depth / stencil with WebGPU start
 * 'ok' (depth24plus depth now previews via the sampling blit, stencil via
 * stencil-only copy); bound textures / no-WebGPU start at their terminal state.
 */
function deriveInitialStatus(thumb: ThumbnailEntry | undefined): RtStatus {
  if (!thumb) return 'no-rt';
  if (thumb.kind === 'bound-texture') {
    // Non-previewable bound formats (3d / non-8-bit color / ...) seed 'no-rt'
    // (honest fallback). Previewable bound textures (sliceable dim + depth/8-bit
    // color) seed 'ok' (or 'no-webgpu') so the anchor is meaningful before replay.
    if (!isBoundPreviewable(thumb.dimension ?? '2d', thumb.format)) return 'no-rt';
    if (typeof navigator === 'undefined' || navigator.gpu === undefined) return 'no-webgpu';
    return 'ok';
  }
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) return 'no-webgpu';
  return 'ok';
}

function statusColor(status: string): string {
  switch (status) {
    case 'ok':
      return 'bg-success/15 text-success';
    case 'no-rt':
      return 'bg-warning/15 text-warning';
    case 'no-webgpu':
    case 'error':
      return 'bg-danger/15 text-danger';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Paint a normalized depth Float32Array ([0,1], tight) as grayscale onto the canvas. */
function paintDepthGrayscale(canvas: HTMLCanvasElement, depth: Float32Array, w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const g = Math.round((depth[i] ?? 0) * 255);
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  return true;
}

/**
 * Decode tight raw readback bytes of any uncompressed color format into RGBA8 and
 * paint them onto the canvas. decodeToRgba8 (texel-decode) handles channels,
 * bit-width, BGRA swizzle, packed formats, and the [0,1]-clamp display map for
 * floats. Returns false on a missing 2d context or an undecodable format.
 */
function paintColorPixels(
  canvas: HTMLCanvasElement,
  pixels: Uint8Array,
  w: number,
  h: number,
  format: string,
): boolean {
  const rgba = decodeToRgba8(pixels, format, w, h);
  if (!rgba) return false;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  return true;
}

// Zoom is either fit-to-window or an explicit scale factor. The ladder is the
// +/- button step sequence; the percentage input accepts any value in [1, 1600]%.
type Zoom = 'fit' | number;
const ZOOM_LADDER = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
const ZOOM_MIN = 0.01;
const ZOOM_MAX = 16;

/** Step the zoom up/down one ladder rung. 'fit' steps relative to 1x. */
function stepZoom(zoom: Zoom, dir: 1 | -1): number {
  const current = zoom === 'fit' ? 1 : zoom;
  if (dir === 1) {
    return ZOOM_LADDER.find((z) => z > current + 1e-6) ?? ZOOM_MAX;
  }
  return [...ZOOM_LADDER].reverse().find((z) => z < current - 1e-6) ?? ZOOM_MIN;
}

export function TextureViewer(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const tape = useTape();
  const { selectedDrawIdx } = useSelection();
  const [selectedThumb, setSelectedThumb] = useState(0);
  const [selectedSlice, setSelectedSlice] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<RtStatus>('no-rt');
  const [message, setMessage] = useState<string | null>(null);
  // Zoom toolbar: 'fit' auto-sizes; a number scales the canvas in CSS px relative
  // to its texture dimensions (`dims`, set when a preview paints).
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const noDraw = !vm || selectedDrawIdx < 0 || selectedDrawIdx >= vm.draws.length;
  const draw = noDraw ? undefined : (vm as ViewModel).draws[selectedDrawIdx];
  const thumbnails = draw ? collectThumbnails(draw, tape?.events ?? []) : [];
  const selected = thumbnails[selectedThumb];
  const slices = selected ? sliceCount(selected.dimension ?? '2d', selected.arrayLayers ?? 1) : 1;

  // Reset thumbnail selection when the draw changes so we don't index past the
  // new draw's thumbnail count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on draw change only
  useEffect(() => {
    setSelectedThumb(0);
  }, [selectedDrawIdx]);

  // Reset the slice selector when the selected thumbnail changes (a different
  // texture has a different slice count).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on thumbnail change only
  useEffect(() => {
    setSelectedSlice(0);
  }, [selectedThumb]);

  // Render the selected thumbnail's real pixels.
  useEffect(() => {
    let cancelled = false;

    // Record the painted texture's true dimensions for the zoom toolbar. Functional
    // update returns the SAME object when unchanged so React bails (no setState loop).
    const markDims = (w: number, h: number) =>
      setDims((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));

    // Seed the optimistic status synchronously so the data-forgeax-rt-status
    // anchor is meaningful before the async replay resolves (the real paint is
    // confirmed by polling canvas pixels). Cleared message until render decides.
    setStatus(deriveInitialStatus(selected));
    setMessage(null);

    async function render() {
      if (!tape || !draw || !selected) {
        setStatus('no-rt');
        setMessage(null);
        return;
      }

      // Non-previewable bound textures (3d, non-8-bit color, compressed, ...) have
      // no scoped readback path — honest message, no GPU attempt. Previewable bound
      // textures (sliceable dim + depth/8-bit color) fall through to the readback below.
      if (
        selected.kind === 'bound-texture' &&
        !isBoundPreviewable(selected.dimension ?? '2d', selected.format)
      ) {
        setStatus('no-rt');
        setMessage(
          `${selected.format} (${selected.dimension ?? '2d'}) bound texture is not directly previewable here — ` +
            'inspect it via the Resource Inspector.',
        );
        return;
      }

      if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
        setStatus('no-webgpu');
        setMessage(null);
        return;
      }

      const sessionResult = await ensureReplaySession(tape);
      if (cancelled) return;
      if (!sessionResult.ok) {
        if (sessionResult.error.kind === 'no-webgpu') {
          setStatus('no-webgpu');
          setMessage(null);
        } else {
          setStatus('error');
          setMessage(sessionResult.error.message);
        }
        return;
      }
      const { replay, device } = sessionResult.value;

      // Rewind then commit through the selected draw so the attachment holds the
      // cumulative draws-0..N pixels (selecting draw #N shows the frame after N).
      replay.reset();
      const commitResult = await replay.commitThroughDraw(selectedDrawIdx);
      if (cancelled) return;
      if (!commitResult.ok) {
        setStatus('error');
        setMessage(`Replay failed: ${commitResult.error.code}`);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        setStatus('error');
        setMessage('Canvas element not mounted');
        return;
      }

      if (selected.kind === 'color-rt') {
        if (!commitResult.value.committed) {
          setStatus('no-rt');
          setMessage('This draw has no color render target');
          return;
        }
        const rtResult = await renderRtToCanvas(replay, selectedDrawIdx, device, canvas);
        if (cancelled) return;
        if (!rtResult.ok) {
          setStatus('no-rt');
          setMessage(null);
          return;
        }
        // renderRtToCanvas resizes the canvas drawing buffer to the RT dims.
        if (canvas.width > 0 && canvas.height > 0) markDims(canvas.width, canvas.height);
        setStatus('ok');
        setMessage(null);
        return;
      }

      // Previewable bound texture: resolve the source texture, read it back, paint.
      // The binding's source texture is live after commitThroughDraw (it was created
      // and seeded before this draw sampled it).
      if (selected.kind === 'bound-texture') {
        const desc = resolveTextureDescriptor(tape.events, selected.handleId);
        if (!desc) {
          setStatus('no-rt');
          setMessage('Bound texture not found in tape');
          return;
        }
        const liveTexture = replay._resolveHandle(desc.handleId);
        if (!liveTexture) {
          setStatus('error');
          setMessage('Bound texture not live after replay');
          return;
        }
        // Clamp the slice to the texture's range (state may lag a thumbnail change).
        const layer = Math.min(selectedSlice, Math.max(0, desc.arrayLayers - 1));
        try {
          if (isDepthFormat(desc.format)) {
            // Bound depth texture: same faithful depth path as the depth attachment
            // (readbackDepthAuto branches direct-readback vs blit by format), then
            // normalize + grayscale. `layer` selects one cube/array slice.
            const depth = await readbackDepthAuto(
              device,
              createShaderModule,
              liveTexture,
              desc.format,
              desc.width,
              desc.height,
              layer,
            );
            if (cancelled) return;
            const { data } = normalizeDepth(depth.buffer, desc.width, desc.height, desc.width * 4);
            const painted = paintDepthGrayscale(canvas, data, desc.width, desc.height);
            if (painted) markDims(desc.width, desc.height);
            setStatus(painted ? 'ok' : 'error');
            setMessage(painted ? null : '2d canvas context unavailable');
          } else {
            // bytesPerTexel(format) sizes the readback (rgba16float = 8 B, etc.);
            // the default 4 would misread anything wider/narrower than rgba8.
            const pixels = await readbackTexturePixels(
              device,
              liveTexture,
              desc.width,
              desc.height,
              { baseArrayLayer: layer, bytesPerTexel: bytesPerTexel(desc.format as never) ?? 4 },
            );
            if (cancelled) return;
            const painted = paintColorPixels(canvas, pixels, desc.width, desc.height, desc.format);
            if (painted) markDims(desc.width, desc.height);
            setStatus(painted ? 'ok' : 'error');
            setMessage(painted ? null : '2d canvas context unavailable');
          }
        } catch (e) {
          if (cancelled) return;
          setStatus('error');
          setMessage(
            `Bound texture readback failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }

      // Depth / Stencil: resolve the source depth-stencil texture (shared by both).
      const desc = resolveDepthTextureDescriptor(
        tape.events,
        draw.depthStencil.depthStencilViewHandleId,
      );
      if (!desc) {
        setStatus('no-rt');
        setMessage('Depth attachment texture not found in tape');
        return;
      }
      const liveTexture = replay._resolveHandle(desc.handleId);
      if (!liveTexture) {
        setStatus('error');
        setMessage('Depth texture not live after replay');
        return;
      }

      // Stencil plane: stencil8 IS copyable (aspect:'stencil-only'); read it
      // directly and normalize to grayscale (raw stencil values are tiny ints).
      if (selected.kind === 'stencil') {
        try {
          const stencil = await readbackStencilTexture(
            device,
            liveTexture,
            desc.width,
            desc.height,
          );
          if (cancelled) return;
          // Widen u8 -> f32 so normalizeDepth (min/max stretch) applies uniformly.
          const f = new Float32Array(stencil.length);
          for (let i = 0; i < stencil.length; i++) f[i] = stencil[i] ?? 0;
          const { data } = normalizeDepth(f.buffer, desc.width, desc.height, desc.width * 4);
          const painted = paintDepthGrayscale(canvas, data, desc.width, desc.height);
          if (painted) markDims(desc.width, desc.height);
          setStatus(painted ? 'ok' : 'error');
          setMessage(painted ? null : '2d canvas context unavailable');
        } catch (e) {
          if (cancelled) return;
          setStatus('error');
          setMessage(`Stencil readback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      // Depth plane. readbackDepthAuto picks the faithful path by format: depth24plus*
      // forbids copyTextureToBuffer on the depth plane, so it samples into an r32float
      // RT via the blit (no format change); copyable formats read back directly.
      try {
        const depth = await readbackDepthAuto(
          device,
          createShaderModule,
          liveTexture,
          selected.format,
          desc.width,
          desc.height,
        );
        if (cancelled) return;
        // Both paths return a tight Float32Array (stride = width) -> width*4 bytes.
        const { data } = normalizeDepth(depth.buffer, desc.width, desc.height, desc.width * 4);
        const painted = paintDepthGrayscale(canvas, data, desc.width, desc.height);
        if (painted) markDims(desc.width, desc.height);
        setStatus(painted ? 'ok' : 'error');
        setMessage(painted ? null : '2d canvas context unavailable');
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setMessage(`Depth readback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [tape, draw, selected, selectedDrawIdx, selectedSlice]);

  // Reset zoom to fit when the selected texture changes (different size, fresh view).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on thumbnail change only
  useEffect(() => {
    setZoom('fit');
  }, [selectedThumb, selectedDrawIdx]);

  const mode: 'selected' | 'default' = noDraw ? 'default' : 'selected';

  if (noDraw || !draw) {
    return (
      <div
        className="p-4 h-full bg-background flex items-center justify-center"
        {...{ [textureViewerAnchor()]: mode, [rtStatusAnchor()]: 'no-rt' }}
      >
        <p className="text-xs text-muted-foreground">Select a draw command to view textures</p>
      </div>
    );
  }

  return (
    <div
      className="h-full bg-background flex flex-row"
      {...{ [textureViewerAnchor()]: mode, [rtStatusAnchor()]: status }}
    >
      {/* Left: Thumbnail strip */}
      <div className="w-36 shrink-0 overflow-y-auto border-r border-border p-1 space-y-1">
        {thumbnails.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">No textures</p>
        ) : (
          thumbnails.map((t, i) => (
            <button
              key={t.handleId}
              type="button"
              onClick={() => setSelectedThumb(i)}
              className={`w-full text-left p-1 rounded text-xs border transition-colors ${
                i === selectedThumb
                  ? 'border-brand/50 bg-brand/10'
                  : 'border-border hover:border-muted-foreground/40'
              }`}
              {...{ [textureThumbnailAnchor()]: String(i) }}
            >
              <div className="flex items-center gap-1 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    t.kind === 'color-rt'
                      ? 'bg-brand'
                      : t.kind === 'depth'
                        ? 'bg-info'
                        : t.kind === 'stencil'
                          ? 'bg-success'
                          : 'bg-warning'
                  }`}
                />
                <span className="truncate text-foreground">{t.label}</span>
              </div>
              <div className="mt-0.5">
                <span
                  className={`inline-block px-1 py-0.5 rounded text-[10px] ${statusColor(t.status.status)}`}
                >
                  {t.status.status}
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Right: Main preview area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2">
              <span className="text-xs text-foreground">{selected.label}</span>
              <span className="text-xs text-muted-foreground">format: {selected.format}</span>
              <span
                className={`inline-block px-1 py-0.5 rounded text-[10px] ${statusColor(status)}`}
              >
                {status}
              </span>
              {/* Slice selector for cube / cube-array / 2d-array bound textures — each
                  slice is one 2D image previewed via baseArrayLayer. */}
              {slices > 1 && (
                <select
                  value={selectedSlice}
                  onChange={(e) => setSelectedSlice(Number(e.target.value))}
                  className="text-[10px] bg-muted text-foreground rounded px-1 py-0.5 border border-border"
                  {...{ [textureSliceAnchor()]: String(selectedSlice) }}
                >
                  {Array.from({ length: slices }, (_, s) =>
                    sliceLabel(selected.dimension ?? '2d', s),
                  ).map((label, s) => (
                    // Label is unique + stable per slice (face/layer name) — safe key.
                    <option key={label} value={s}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              {/* Zoom toolbar — shown once a preview paints. Buttons step the ladder;
                  the percentage input commits any value (pixelated magnification). */}
              {status === 'ok' && (
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setZoom(stepZoom(zoom, -1))}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted text-foreground hover:border-muted-foreground/40"
                    title="Zoom out"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={1600}
                    value={zoom === 'fit' ? '' : Math.round(zoom * 100)}
                    placeholder={zoom === 'fit' ? 'fit' : '100'}
                    onChange={(e) => {
                      const pct = Number(e.target.value);
                      if (!Number.isFinite(pct) || pct <= 0) return;
                      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct / 100)));
                    }}
                    className="w-12 text-[10px] bg-muted text-foreground rounded px-1 py-0.5 border border-border text-right"
                    {...{
                      [textureZoomAnchor()]:
                        zoom === 'fit' ? 'fit' : String(Math.round(zoom * 100)),
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">%</span>
                  <button
                    type="button"
                    onClick={() => setZoom(stepZoom(zoom, 1))}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted text-foreground hover:border-muted-foreground/40"
                    title="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom('fit')}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      zoom === 'fit'
                        ? 'border-brand/50 bg-brand/10 text-foreground'
                        : 'border-border bg-muted text-foreground hover:border-muted-foreground/40'
                    }`}
                    title="Fit to window"
                  >
                    Fit
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      zoom === 1
                        ? 'border-brand/50 bg-brand/10 text-foreground'
                        : 'border-border bg-muted text-foreground hover:border-muted-foreground/40'
                    }`}
                    title="Actual size (1:1)"
                  >
                    1:1
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
              {/* Canvas stays mounted whenever rendering is possible (avoids the
                  "canvas not mounted" race when status flips); hidden unless ok. */}
              <canvas
                ref={canvasRef}
                {...{ [rtCanvasAnchor()]: '' }}
                className={
                  zoom === 'fit'
                    ? // Fit fills the viewport and object-contain scales the bitmap to
                      // it preserving aspect — so a 1x1 / tiny texture is UPSCALED to a
                      // crisp pixelated block, not left at its 1px intrinsic size.
                      'w-full h-full object-contain block bg-[#0a0a0a] rounded'
                    : 'block bg-[#0a0a0a] rounded shrink-0'
                }
                style={{
                  display: status === 'ok' ? 'block' : 'none',
                  // Crisp magnification: small / 1x1 textures blow up pixelated, not blurred.
                  imageRendering: 'pixelated',
                  // Explicit CSS size when a scale is chosen (drawing buffer stays = texture size).
                  ...(zoom !== 'fit' && dims
                    ? { width: `${dims.w * zoom}px`, height: `${dims.h * zoom}px` }
                    : {}),
                }}
              />
              {status !== 'ok' && (
                <p className="text-xs text-muted-foreground text-center px-4">
                  {message ??
                    (status === 'no-webgpu'
                      ? 'WebGPU not available — preview requires a WebGPU-enabled browser'
                      : 'No preview for this attachment')}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-muted-foreground">No texture selected</p>
          </div>
        )}
      </div>
    </div>
  );
}
