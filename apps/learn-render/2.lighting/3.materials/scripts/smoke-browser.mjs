// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/3.materials. The demo owns the live pixel hook;
// the shared harness captures, replays on fresh dawn-node, and compares RTs.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-3-materials',
  label: 'learn-render 2.3 materials',
  mode: 'pixel',
  liveHook: '__captureMaterials',
  rtIdx: 0,
  appDir: dirname(here),
});
