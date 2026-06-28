// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/2.basic-lighting (static scene: lit cube + lamp,
// first-person controls input-gated so no motion without input). Delegates to
// the shared harness; this file only supplies the demo identity + its live-pixel
// hook (window.__captureBasicLighting, installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-2-basic-lighting',
  label: 'learn-render 2.2 basic-lighting',
  mode: 'pixel',
  liveHook: '__captureBasicLighting',
  rtIdx: 0,
  appDir: dirname(here),
});
