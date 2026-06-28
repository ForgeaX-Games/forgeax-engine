// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/4.lighting-maps (static scene: diffuse+specular maps
// on a lit cube, first-person controls input-gated so no motion without input).
// Delegates to the shared harness; this file only supplies the demo identity +
// its live-pixel hook (window.__captureLightingMaps, installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-4-lighting-maps',
  label: 'learn-render 2.4 lighting-maps',
  mode: 'pixel',
  liveHook: '__captureLightingMaps',
  rtIdx: 0,
  appDir: dirname(here),
});
