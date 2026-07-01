// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x ssao (9.ssao). Delegates to the shared harness; supplies
// demo identity + live-pixel hook (window.__captureSsao, installed by
// src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-9-ssao',
  label: 'learn-render 5.9 ssao',
  mode: 'pixel',
  liveHook: '__captureSsao',
  rtIdx: 0,
  appDir: dirname(here),
  // SSAO's HDRP pipeline + backpack.gltf load makes app.start()'s renderer.ready
  // chain (manifest -> pipeline -> asset upload) slower than the 3s default; a
  // short warmup armed capture before the rAF loop produced its first frame, so
  // onFrameEnd never fired and waitForRecorderIdle hung. Give it more headroom.
  warmupMs: 8000,
});
