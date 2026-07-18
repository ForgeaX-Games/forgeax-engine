// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x deferred shading (8.deferred-shading). Delegates to the
// shared harness; supplies demo identity + live-pixel hook
// (window.__captureDeferred, installed by src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading',
  label: 'learn-render 5.8 deferred',
  mode: 'pixel',
  liveHook: '__captureDeferred',
  rtIdx: 0,
  appDir: dirname(here),
});
