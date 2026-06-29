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
//   - Bound textures -> shown in the strip with status; not RT-previewable per-draw
//     (they are pipeline inputs, not this draw's output).
//
// Status anchor values (data-forgeax-rt-status): ok | no-rt | no-webgpu | error.
//
// Related: requirements AC-06/AC-16/AC-18/AC-26; plan-strategy D-4/D-5.

/// <reference types="@webgpu/types" />

import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import { normalizeDepth } from '../depth-normalize';
import { ensureReplaySession } from '../replay-session';
import { useSelection } from '../selection-context';
import type { RtStatus } from '../selectors';
import {
  rtCanvasAnchor,
  rtStatusAnchor,
  textureThumbnailAnchor,
  textureViewerAnchor,
} from '../selectors';
import { readbackDepthTexture, resolveDepthTextureDescriptor } from '../texture-readback';
import type { TextureDescriptor, TextureStatusEntry } from '../texture-status';
import { computeTextureStatus } from '../texture-status';
import { useTape, useViewModel } from '../viewer-context';
import type { DrawEntry, ViewModel } from '../viewer-model';

/** A thumbnail entry representing one texture attached to the selected draw. */
interface ThumbnailEntry {
  readonly handleId: string;
  readonly label: string;
  readonly format: string;
  readonly kind: 'color-rt' | 'depth' | 'bound-texture';
  readonly status: TextureStatusEntry;
}

const NON_COPYABLE_DEPTH = new Set(['depth24plus', 'depth24plus-stencil8']);

function collectThumbnails(draw: DrawEntry): readonly ThumbnailEntry[] {
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
    entries.push({
      handleId: draw.depthStencil.depthStencilViewHandleId,
      label: 'Depth',
      format: depthFormat,
      kind: 'depth',
      status: {
        handleId: draw.depthStencil.depthStencilViewHandleId,
        status: 'ok',
        format: depthFormat,
      },
    });
  }

  // Bound textures from bindings
  const seen = new Set<string>();
  for (const binding of draw.bindings) {
    if (binding.kind === 'texture' || binding.kind === 'textureView') {
      const handleId = binding.handleId;
      if (!seen.has(handleId)) {
        seen.add(handleId);
        entries.push({
          handleId,
          label: `Texture ${handleId}`,
          format: 'unknown',
          kind: 'bound-texture',
          status: { handleId, status: 'ok', format: 'unknown' },
        });
      }
    }
  }

  // Apply per-texture status matrix
  const descriptors: readonly TextureDescriptor[] = entries.map((e) => ({
    handleId: e.handleId,
    format: e.format,
  }));
  const statuses = computeTextureStatus(descriptors, true);
  return entries.map((e, i) => {
    const st = statuses[i];
    return st ? { ...e, status: st } : e;
  });
}

/**
 * Optimistic status the panel shows synchronously before the async replay
 * resolves — mirrors the former RtPanel.deriveStatus so the data-forgeax-rt-status
 * anchor reads a meaningful value immediately (consumers poll the canvas pixels
 * for the real-paint confirmation). Color RT with WebGPU starts 'ok'; non-copyable
 * depth starts 'error'; bound textures / no-WebGPU start at their terminal state.
 */
function deriveInitialStatus(thumb: ThumbnailEntry | undefined): RtStatus {
  if (!thumb) return 'no-rt';
  if (thumb.kind === 'depth' && NON_COPYABLE_DEPTH.has(thumb.format)) return 'error';
  if (thumb.kind === 'bound-texture') return 'no-rt';
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

export function TextureViewer(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const tape = useTape();
  const { selectedDrawIdx } = useSelection();
  const [selectedThumb, setSelectedThumb] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<RtStatus>('no-rt');
  const [message, setMessage] = useState<string | null>(null);

  const noDraw = !vm || selectedDrawIdx < 0 || selectedDrawIdx >= vm.draws.length;
  const draw = noDraw ? undefined : (vm as ViewModel).draws[selectedDrawIdx];
  const thumbnails = draw ? collectThumbnails(draw) : [];
  const selected = thumbnails[selectedThumb];

  // Reset thumbnail selection when the draw changes so we don't index past the
  // new draw's thumbnail count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on draw change only
  useEffect(() => {
    setSelectedThumb(0);
  }, [selectedDrawIdx]);

  // Render the selected thumbnail's real pixels.
  useEffect(() => {
    let cancelled = false;

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

      // Non-copyable depth: honest message, no GPU attempt (AC-18).
      if (selected.kind === 'depth' && NON_COPYABLE_DEPTH.has(selected.format)) {
        setStatus('error');
        setMessage(
          `${selected.format} is not GPU-copyable (WebGPU forbids copyTextureToBuffer on it). ` +
            'Re-capture with a depth32float depth target to preview the depth buffer.',
        );
        return;
      }

      // Bound textures are pipeline inputs, not this draw's output — no per-draw RT path.
      if (selected.kind === 'bound-texture') {
        setStatus('no-rt');
        setMessage(
          'Bound input texture — preview the Color RT / Depth attachment, or inspect it via the Resource Inspector.',
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
        setStatus('ok');
        setMessage(null);
        return;
      }

      // Copyable depth: resolve the source texture, read it back, normalize, paint.
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
      try {
        const depth = await readbackDepthTexture(device, liveTexture, desc.width, desc.height);
        if (cancelled) return;
        // readbackTexturePixels returns tight rows (no padding) -> stride = width*4.
        const { data } = normalizeDepth(depth.buffer, desc.width, desc.height, desc.width * 4);
        const painted = paintDepthGrayscale(canvas, data, desc.width, desc.height);
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
  }, [tape, draw, selected, selectedDrawIdx]);

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
            </div>
            <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
              {/* Canvas stays mounted whenever rendering is possible (avoids the
                  "canvas not mounted" race when status flips); hidden unless ok. */}
              <canvas
                ref={canvasRef}
                {...{ [rtCanvasAnchor()]: '' }}
                className="max-w-full max-h-full object-contain block bg-[#0a0a0a] rounded"
                style={{ display: status === 'ok' ? 'block' : 'none' }}
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
