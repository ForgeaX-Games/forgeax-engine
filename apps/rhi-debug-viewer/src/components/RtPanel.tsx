// RtPanel.tsx — render target panel with lazy GPU replay (M4 enhancement).
//
// Milestone M3: placeholder showing static message (no GPU).
// Milestone M4 (w17): full GPU-capable RT viewer.
//   - On draw selection, if draw has a colorAttachmentHandleId, calls
//     ensureReplaySession(tape) (w16) to lazily bootstrap a WebGPU replay
//     device, then stepTo(targetDrawIdx) + renderRtToCanvas to a <canvas>.
//   - Sets data-forgeax-rt-status attribute: ok / no-rt / no-webgpu / error.
//   - createReplay is called once and reused across draw re-selections (C7).
//   - Compute-only or no-color-attachment draws show no-rt state (AC-08).
//   - No-WebGPU environment preserves layout, shows centered text (AC-09).
//
// Related: AC-06/AC-07/AC-08/AC-09/C7; plan-strategy D-2/D-8/D-10;
// research Finding 3/Finding 4/Finding 5/Finding 6.

import type { Tape } from '@forgeax/engine-rhi-debug';
import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
import { useEffect, useRef, useState } from 'react';
import { ensureReplaySession } from '../replay-session';
import type { RtStatus } from '../selectors';
import { rtCanvasAnchor, rtStatusAnchor } from '../selectors';
import type { ViewModel } from '../viewer-model';

export interface RtPanelProps {
  readonly selectedDrawIdx: number;
  readonly tape: Tape | null;
  readonly viewModel: ViewModel;
}

/** Derive RtStatus for the currently selected draw from the ViewModel. */
function deriveStatus(vm: ViewModel, drawIdx: number): RtStatus {
  if (drawIdx < 0 || drawIdx >= vm.draws.length) {
    return 'no-rt';
  }
  const draw = vm.draws[drawIdx];
  if (draw === undefined) return 'no-rt';
  if (draw.colorAttachmentHandleId === undefined) return 'no-rt';

  // Check navigator.gpu availability synchronously first
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return 'no-webgpu';
  }

  return 'ok';
}

export function RtPanel({ selectedDrawIdx, tape, viewModel }: RtPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<RtStatus>(() => deriveStatus(viewModel, selectedDrawIdx));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderRt() {
      if (tape === null) {
        setStatus('no-webgpu');
        return;
      }

      const derived = deriveStatus(viewModel, selectedDrawIdx);
      if (derived === 'no-rt' || derived === 'no-webgpu') {
        setStatus(derived);
        return;
      }

      // derived === 'ok': draw has color attachment and WebGPU is available
      const sessionResult = await ensureReplaySession(tape);
      if (cancelled) return;

      if (!sessionResult.ok) {
        if (sessionResult.error.kind === 'no-webgpu') {
          setStatus('no-webgpu');
        } else {
          setStatus('error');
          setErrorMessage(sessionResult.error.message);
        }
        return;
      }

      const { replay, device } = sessionResult.value;

      // Step the replay to the target draw index so its enclosing render pass
      // is replayed and the pipeline + resources are created on the device.
      // We need to find the last event index within the enclosing render pass.
      // The draw event index in the raw events array may not match drawIdx,
      // but stepTo expects the event index. We step to the end of all events
      // to ensure the full frame is replayed before reading back.
      const eventCount = tape.events.length;
      const stepResult = await replay.stepTo(eventCount - 1);
      if (cancelled) return;

      if (!stepResult.ok) {
        setStatus('error');
        setErrorMessage(`Replay stepTo failed: ${stepResult.error.code}`);
        return;
      }

      const canvas = canvasRef.current;
      if (canvas === null) {
        setStatus('error');
        setErrorMessage('Canvas element not mounted');
        return;
      }

      // Size the canvas to match the RT (find texture dimensions from tape events)
      const draw = viewModel.draws[selectedDrawIdx];
      if (draw === undefined) {
        setStatus('no-rt');
        return;
      }

      // Resolve RT dimensions from the tape's createTexture event for the color attachment
      let texWidth = 800;
      let texHeight = 600;
      const ctaHandleId = draw.colorAttachmentHandleId;
      if (ctaHandleId !== undefined) {
        // Walk createTextureView -> sourceHandleId -> createTexture.size
        let sourceHandleId: string | undefined;
        for (const ev of tape.events) {
          if (ev.kind === 'createTextureView' && ev.resultHandleId === ctaHandleId) {
            sourceHandleId = ev.sourceHandleId;
            break;
          }
        }
        const textureHandleId = sourceHandleId ?? ctaHandleId;
        for (const ev of tape.events) {
          if (ev.kind === 'createTexture' && ev.handleId === textureHandleId) {
            const sz = ev.desc.size;
            if (Array.isArray(sz)) {
              texWidth = typeof sz[0] === 'number' ? sz[0] : 800;
              texHeight = typeof sz[1] === 'number' ? sz[1] : texWidth;
            } else {
              const obj = sz as { width: number; height?: number };
              texWidth = typeof obj.width === 'number' ? obj.width : 800;
              texHeight = typeof obj.height === 'number' ? obj.height : texWidth;
            }
            break;
          }
        }
      }
      canvas.width = texWidth;
      canvas.height = texHeight;

      const rtResult = await renderRtToCanvas(replay, selectedDrawIdx, device, canvas);
      if (cancelled) return;

      if (!rtResult.ok) {
        setStatus('no-rt');
        return;
      }

      setStatus('ok');
      setErrorMessage(null);
    }

    renderRt();

    return () => {
      cancelled = true;
    };
  }, [tape, viewModel, selectedDrawIdx]);

  return (
    <div
      {...{ [rtStatusAnchor()]: status }}
      className="border border-slate-200 dark:border-slate-800 rounded-lg p-6"
    >
      <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-3">Render Target</h3>

      {status === 'ok' && (
        <canvas
          ref={canvasRef}
          {...{ [rtCanvasAnchor()]: '' }}
          className="max-w-full h-auto block"
        />
      )}

      {status === 'no-rt' && (
        <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">
          This draw has no render target
        </p>
      )}

      {status === 'no-webgpu' && (
        <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">
          WebGPU not available &mdash; RT preview requires a WebGPU-enabled browser
        </p>
      )}

      {status === 'error' && (
        <div className="text-center py-8">
          <p className="text-sm text-red-500 dark:text-red-400">Render target readback failed</p>
          {errorMessage !== null && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{errorMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}
