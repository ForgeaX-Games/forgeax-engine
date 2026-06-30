// @forgeax/engine-app/internal/hmr-capture-listener -- HMR capture listener registration (SSOT).
//
// Extracted from create-app.ts per plan-strategy D-5: the exported
// registerCaptureHmrListener function is imported by both create-app.ts
// (production) and create-app-hmr.test.ts (test spy/mock assertions),
// eliminating the shadow-copy trap where a copied handler in tests stays
// green while the real create-app.ts handler drifts (charter P3: explicit
// failure -- test must guard the shipped code, not a clone).
//
// Constraints: requirements C2/C3 (called only inside rhiDebugFlag==='1'
// guard + if (import.meta.hot) guard); plan-strategy D-5 (handler calls
// captureAndUpload directly with three args: debugInst, frames, label);
// research Finding 2 (cb single-param payload).

import type { CaptureBrowserRecorder } from '@forgeax/engine-rhi-debug/capture-browser';

export function registerCaptureHmrListener(
  hot: { on(event: string, cb: (payload: { frames?: number; label?: string }) => void): void },
  debugInst: CaptureBrowserRecorder,
): void {
  hot.on('forgeax-debug:capture', (payload: { frames?: number; label?: string }) => {
    import('@forgeax/engine-rhi-debug/capture-browser').then((m) =>
      m.captureAndUpload(debugInst, payload.frames ?? 1, payload.label),
    );
  });
}
