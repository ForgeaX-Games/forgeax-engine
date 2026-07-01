// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x normal-mapping. Delegates to the shared harness; this file only
// supplies the demo identity + its live-pixel hook (window.__captureNormalMapping, installed by
// src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping',
  label: 'learn-render 5.4 normal-mapping',
  mode: 'pixel',
  liveHook: '__captureNormalMapping',
  rtIdx: 0,
  appDir: dirname(here),
});
