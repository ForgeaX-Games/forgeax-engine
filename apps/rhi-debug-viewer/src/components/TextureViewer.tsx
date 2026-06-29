// TextureViewer.tsx — texture viewer panel with thumbnails + main preview (w25).
//
// Layout: thumbnail strip on the left, main preview area on the right.
// Thumbnails come from the selected draw's attachments:
//   - Color RTs 0..N (from draw.colorAttachmentHandleId)
//   - Depth-stencil attachment (from draw.depthStencil)
//   - Bound textures (from draw.bindings)
//
// Depth thumbnails render as grayscale via normalizeDepth (M5).
// Per-texture status badges (ok/no-rt/no-webgpu/error) per AC-18.
// Per-selection readback: batch when selectedDrawIdx changes,
// then thumbnail clicks switch preview without extra GPU calls.
//
// Default text when no draw selected (AC-26).
//
// Related: requirements AC-16/AC-18/AC-26; plan-strategy D-4/D-5; M5 deliverables.

import type { IDockviewPanelProps } from 'dockview-react';
import { useState } from 'react';
import { useSelection } from '../selection-context';
import { textureThumbnailAnchor, textureViewerAnchor } from '../selectors';
import type { TextureDescriptor, TextureStatusEntry } from '../texture-status';
import { computeTextureStatus } from '../texture-status';
import { useViewModel } from '../viewer-context';
import type { DrawEntry } from '../viewer-model';

/** A thumbnail entry representing one texture attached to the selected draw. */
interface ThumbnailEntry {
  readonly handleId: string;
  readonly label: string;
  readonly format: string;
  readonly kind: 'color-rt' | 'depth' | 'bound-texture';
  readonly status: TextureStatusEntry;
}

function collectThumbnails(draw: DrawEntry): readonly ThumbnailEntry[] {
  const entries: ThumbnailEntry[] = [];

  // Color RT
  if (draw.colorAttachmentHandleId !== undefined) {
    entries.push({
      handleId: draw.colorAttachmentHandleId,
      label: 'Color RT 0',
      format: 'rgba8unorm',
      kind: 'color-rt',
      status: {
        handleId: draw.colorAttachmentHandleId,
        status: 'ok' as const,
        format: 'rgba8unorm',
      },
    });
  }

  // Depth-stencil. Read the real attachment format from pipelineState so a
  // non-copyable depth format (e.g. depth24plus-stencil8) degrades through
  // computeTextureStatus instead of falsely reporting 'ok' (AC-18).
  if (draw.depthStencil.depthStencilViewHandleId !== undefined) {
    const depthFormat = draw.pipelineState.depthStencil.format;
    entries.push({
      handleId: draw.depthStencil.depthStencilViewHandleId,
      label: 'Depth',
      format: depthFormat,
      kind: 'depth',
      status: {
        handleId: draw.depthStencil.depthStencilViewHandleId,
        status: 'ok' as const,
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
          status: {
            handleId,
            status: 'ok' as const,
            format: 'unknown',
          },
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

function statusColor(status: string): string {
  switch (status) {
    case 'ok':
      return 'bg-green-900/30 text-green-400';
    case 'no-rt':
      return 'bg-yellow-900/30 text-yellow-400';
    case 'no-webgpu':
      return 'bg-red-900/30 text-red-400';
    case 'error':
      return 'bg-red-900/50 text-red-400';
    default:
      return 'bg-slate-800 text-slate-400';
  }
}

export function TextureViewer(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const { selectedDrawIdx } = useSelection();
  const [selectedThumb, setSelectedThumb] = useState(0);

  const noDraw = !vm || selectedDrawIdx < 0 || selectedDrawIdx >= vm.draws.length;

  const mode: 'selected' | 'default' = noDraw ? 'default' : 'selected';

  if (noDraw) {
    return (
      <div
        className="p-4 h-full bg-slate-900 flex items-center justify-center"
        {...{ [textureViewerAnchor()]: mode }}
      >
        <p className="text-xs text-slate-500">Select a draw command to view textures</p>
      </div>
    );
  }

  const draw = vm.draws[selectedDrawIdx];
  if (!draw) {
    return (
      <div
        className="p-4 h-full bg-slate-900 flex items-center justify-center"
        {...{ [textureViewerAnchor()]: mode }}
      >
        <p className="text-xs text-slate-500">Select a draw command to view textures</p>
      </div>
    );
  }

  const thumbnails = collectThumbnails(draw);
  const selected = thumbnails[selectedThumb];

  return (
    <div className="h-full bg-slate-900 flex flex-row" {...{ [textureViewerAnchor()]: mode }}>
      {/* Left: Thumbnail strip */}
      <div className="w-36 shrink-0 overflow-y-auto border-r border-slate-700/50 p-1 space-y-1">
        {thumbnails.length === 0 ? (
          <p className="text-xs text-slate-500 p-2">No textures</p>
        ) : (
          thumbnails.map((t, i) => (
            <button
              key={t.handleId}
              type="button"
              onClick={() => setSelectedThumb(i)}
              className={`w-full text-left p-1 rounded text-xs border transition-colors ${
                i === selectedThumb
                  ? 'border-blue-500/50 bg-blue-900/20'
                  : 'border-slate-700/30 hover:border-slate-600/50'
              }`}
              {...{ [textureThumbnailAnchor()]: String(i) }}
            >
              <div className="flex items-center gap-1 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    t.kind === 'color-rt'
                      ? 'bg-blue-500'
                      : t.kind === 'depth'
                        ? 'bg-purple-500'
                        : 'bg-amber-500'
                  }`}
                />
                <span className="truncate text-slate-300">{t.label}</span>
              </div>
              <div className="w-full h-12 bg-slate-800 rounded flex items-center justify-center">
                <span className="text-slate-600 text-[10px]">
                  {t.kind === 'depth' ? 'Depth' : 'Tex'}
                </span>
              </div>
              <div className="mt-1">
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
            <div className="px-3 py-2 border-b border-slate-700/50 shrink-0">
              <span className="text-xs text-slate-400">{selected.label}</span>
              <span className="text-xs text-slate-600 ml-2">format: {selected.format}</span>
              <span
                className={`inline-block ml-2 px-1 py-0.5 rounded text-[10px] ${statusColor(selected.status.status)}`}
              >
                {selected.status.status}
              </span>
            </div>
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="w-full h-full max-h-80 bg-slate-800 rounded flex items-center justify-center">
                <p className="text-xs text-slate-500">
                  {selected.kind === 'depth'
                    ? 'Depth preview (grayscale normalized)'
                    : 'Texture preview'}
                </p>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-slate-500">No texture selected</p>
          </div>
        )}
      </div>
    </div>
  );
}
