// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/1.colors (a static scene: colored cube + lamp +
// directional light, first-person controls input-gated so no motion without
// input). Delegates to the shared harness; this file only supplies the demo's
// identity and its live-pixel hook (window.__captureColors, installed by
// src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (pixelDeltaAbsMean <= eps).
// This is the check that proves "offline replay == the demo's actual render".
//
// Local-only gate (no Chrome+WebGPU on CI runners), same as the other
// scripts/smoke-browser.mjs in this repo.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-1-colors',
  label: 'learn-render 2.1 colors',
  mode: 'pixel',
  liveHook: '__captureColors',
  rtIdx: 0,
  // Uses the harness default thresholds (mean 0.02 / maxChannel 0.10 /
  // coveredMean 0.03). After the srgb-preserving replay fix the measured delta
  // is 0.00000 across the board, so the tight defaults hold with room to spare.
  appDir: dirname(here),
});
