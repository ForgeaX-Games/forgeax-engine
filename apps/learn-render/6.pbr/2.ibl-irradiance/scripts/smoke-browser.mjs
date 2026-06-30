// smoke-browser.mjs -- RHI-debug capture verification for learn-render
// 6.pbr/2.ibl-irradiance (static IBL diffuse sphere matrix, Skylight equirect HDR).
//
// STRUCTURAL mode (not pixel) by design: the Skylight irradiance/prefilter maps
// are rgba16float cubemaps, which the frame-header snapshot SKIPS (the seed path
// is 4-byte single-layer only; recorder.ts isSnapshottableColorTexture + roadmap
// specs §10 residual #1). With the IBL textures unseeded the replayed spheres are
// unlit (measured: maxChannelDelta 1.0, the spheres render black vs the lit live
// frame -- see an early run's compare.png). That is the KNOWN residual, not a new
// bug, so we verify the capture->replay->inspect chain runs (structural) rather
// than pixel-comparing. Upgrade to pixel once residual #1 (rgba16float / cubemap
// seed) lands. Longer warmup so the IBL prewarm completes before capture.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-2-ibl-irradiance',
  label: 'learn-render 6.2 ibl-irradiance',
  mode: 'pixel',
  liveHook: '__captureIblIrradiance',
  rtIdx: 0,
  warmupMs: 5000,
  appDir: dirname(here),
});
