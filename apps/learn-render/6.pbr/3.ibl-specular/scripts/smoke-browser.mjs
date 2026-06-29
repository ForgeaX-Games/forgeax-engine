// smoke-browser.mjs -- RHI-debug capture verification for learn-render
// 6.pbr/3.ibl-specular (static IBL split-sum sphere matrix, Skylight equirect HDR).
//
// STRUCTURAL mode (not pixel) by design: same as sibling 2.ibl-irradiance -- the
// Skylight irradiance/prefilter maps are rgba16float cubemaps the frame-header
// snapshot SKIPS (4-byte single-layer seed only; roadmap specs §10 residual #1).
// With IBL textures unseeded the replayed spheres are unlit, so we verify the
// capture->replay->inspect chain (structural) rather than pixel-comparing.
// Upgrade to pixel once residual #1 lands.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-3-ibl-specular',
  label: 'learn-render 6.3 ibl-specular',
  mode: 'pixel',
  liveHook: '__captureIblSpecular',
  rtIdx: 0,
  warmupMs: 5000,
  appDir: dirname(here),
});
