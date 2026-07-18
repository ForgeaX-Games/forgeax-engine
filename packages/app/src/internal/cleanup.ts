// @forgeax/engine-app -- shared cleanup funnel (M4 / w13).
//
// Public surface (consumed only by createApp -- this module lives under
// `internal/` and is not re-exported from the package barrel):
//
//   const cleanup = makeCleanupFunnel({
//     loop,           // FrameLoopHandle (M2): cancels rAF + flips to 'stopped'
//     inputCleanup,   // (onError) => void from input-attach.ts (M3); optional
//     dispatch,       // (err: AppError) => void: forwards cleanup-internal errors
//   });
//   cleanup({ reason: 'device-lost', lastError: rhiErr });
//   cleanup({ reason: 'stop' });
//
// Wiring (per plan-strategy R-4 + D-2 + D-3):
//
//   - stop()         -> cleanup({ reason: 'stop' })       -- frame-loop already
//                       transitioned to 'idle'; cleanup runs input detach +
//                       removeSystem.
//   - device-lost    -> cleanup({ reason: 'device-lost',
//                                   lastError: rhiErr })  -- frame-loop is
//                       force-transitioned to 'stopped' via setStopped();
//                       cleanup runs input detach + removeSystem; lastError
//                       captured in the registry for host self-inspection.
//   - exception path -> cleanup({ reason: 'exception',
//                                   lastError: appErr })  -- reserved seam for
//                       future feat (e.g. uncaught throw inside frame-loop);
//                       not wired in M4 -- the 'reason' field is already in
//                       place to satisfy the shared funnel contract.
//
// Idempotency (architecture principle 6): cleanup is safe to call more than
// once -- the inner inputCleanup is idempotent (input-attach.ts:97-104) and
// setStopped() is a state machine sink (M2 frame-loop.ts:280-286). Repeat
// calls do not double-fire input detach or re-emit removeSystem errors.

import type { RhiError } from '@forgeax/engine-rhi/errors';

import type { AppDispatchError, AppError } from '../types';
import type { FrameLoopHandle } from './frame-loop';

/**
 * Reason why cleanup is invoked. Maps to plan-strategy R-4 triple-funnel
 * (stop / device-lost / exception throw).
 */
export type CleanupReason = 'stop' | 'device-lost' | 'exception';

/**
 * Cleanup invocation arguments. lastError is provided when the funnel is
 * triggered by a frame-time error path (device-lost / exception); the
 * cleanup callback captures it for host self-inspection.
 */
export interface CleanupArgs {
  readonly reason: CleanupReason;
  readonly lastError?: AppError | RhiError;
}

/**
 * Cleanup funnel callback. Idempotent; safe to call multiple times.
 * Returns void -- input detach failures are surfaced via the
 * dispatch(err) callback at construction (no Result return).
 */
export type CleanupFunnel = (args: CleanupArgs) => void;

export interface CleanupFunnelOptions {
  readonly loop: FrameLoopHandle;
  readonly inputCleanup?: (onError: (err: AppError) => void) => void;
  readonly dispatch: (err: AppDispatchError) => void;
  readonly setLastError: (err: AppDispatchError) => void;
  /**
   * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M6 / AC-08:
   * fired on `reason === 'stop'` so app.stop() chains into the M5
   * Renderer.dispose() 6-step cascade (createRenderer.ts:1774). The
   * funnel's existing `invoked` latch + Renderer.dispose's own idempotency
   * latch (createRenderer.ts:1775) make double-stop a guaranteed no-op.
   *
   * Not fired on `reason === 'device-lost'` -- that path is OOS-1
   * (chromium adapter pool poisoning under repeated device.destroy is
   * tracked in a sibling feat). Funneling through `stop` only keeps the
   * device-lost recovery surface unchanged in this feat.
   */
  readonly rendererDispose?: () => void;
  /**
   * feat-20260619-audio-resource-ownership-deterministic-reclaim / M1 / F23:
   * fired on `reason === 'stop'` so app.stop() chains into
   * WebAudioEngine.destroy() (web-audio-engine.ts:269-298). Same shape as
   * rendererDispose: only on `stop` (host-initiated shutdown), not on
   * device-lost / exception (OOS-2). The funnel's `invoked` latch +
   * destroy's own ctx===undefined short-circuit (Finding 6) make
   * double-stop a guaranteed no-op.
   */
  readonly audioBackendDispose?: () => void;
}

/**
 * Build a cleanup funnel that all three callers (stop / device-lost /
 * exception) converge on (R-4). The funnel:
 *
 *   1. captures lastError if provided (so app.lastError reads it post-
 *      cleanup, useful for host self-inspection on device-lost without
 *      requiring the host to register an onError listener up front);
 *   2. force-transitions the frame-loop into the terminal 'stopped'
 *      state on device-lost / exception reasons (D-2 cancelAnimationFrame
 *      + state stopped); on 'stop' reason the frame-loop is already idle
 *      so no action is needed beyond input cleanup;
 *   3. invokes inputCleanup if wired -- the callable is itself idempotent
 *      (input-attach.ts:97-104) so repeat invocations are no-ops.
 */
export function makeCleanupFunnel(opts: CleanupFunnelOptions): CleanupFunnel {
  const { loop, inputCleanup, dispatch, setLastError, rendererDispose, audioBackendDispose } = opts;
  let invoked = false;
  return ({ reason, lastError }: CleanupArgs): void => {
    if (lastError !== undefined) {
      setLastError(lastError);
    }
    if (invoked) {
      // R-4 idempotency: subsequent calls are safe no-ops. We still
      // capture lastError above so a later device-lost-after-stop event
      // updates the lastError field (charter P3: AI users get the latest
      // signal, not the first one).
      return;
    }
    invoked = true;
    if (reason === 'device-lost' || reason === 'exception') {
      // D-2: force the frame-loop into the terminal 'stopped' state so
      // subsequent start() returns 'app-not-started'. This also cancels
      // the pending rAF handle (M2 setStopped: caf(pendingFrameId)).
      loop.setStopped();
    }
    if (inputCleanup !== undefined) {
      inputCleanup(dispatch);
    }
    if (reason === 'stop' && rendererDispose !== undefined) {
      // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M6 /
      // AC-08: chain into the M5 Renderer.dispose() 6-step cascade. Only
      // on `stop` (host-initiated shutdown); device-lost is OOS-1.
      rendererDispose();
    }
    if (reason === 'stop' && audioBackendDispose !== undefined) {
      // feat-20260619-audio-resource-ownership-deterministic-reclaim / M1 /
      // F23: chain into WebAudioEngine.destroy(). Only on `stop`
      // (host-initiated shutdown); device-lost / exception skip
      // audio resource reclaim (OOS-2). Same shape as rendererDispose.
      audioBackendDispose();
    }
  };
}
