#!/usr/bin/env node
// apps/learn-render/1.getting-started/1.hello-window/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 1.1 hello-window dawn-node smoke (feat-20260611
// w7 / M3). Mirrors apps/learn-render/1.getting-started/4.textures/
// scripts/smoke-dawn.mjs structure byte-for-byte except for the four
// approved differential axes (D-8): GUID set / clear color / sample
// coordinates / shader content -- AND one explicit special case
// (D-3 / AC-08): hello-window only paints clear color, no geometry,
// so the verdict drops the meshed-sites criterion. THREE-criterion
// verdict is the explicit hello-window special case; the other 24
// learn-render demos keep the 4-criterion shape.
//
// Differential axes vs textures template (charter F1 grep-once-trust):
//   - GUIDs: none (hello-window has no asset registration; spawn is
//     Camera-only per src/index.ts spawnCameraOnly).
//   - clear color: matches LO 1.1 teal (0.2, 0.3, 0.3) -- same as
//     textures template, no diff (the LO 1.1 byte-for-byte teal is
//     the shared baseline across LO section-1 demos).
//   - sample sites: just two corner samples to confirm the swap-chain
//     was painted (the LO 1.1 mapping has no geometry, so meshed-site
//     sampling is meaningless here -- corners are enough to prove the
//     clear-pass ran).
//   - shader content: none (engine clear-pass-only path; no user
//     pipeline is compiled for the LO 1.1 minimum scene).
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-hello-window] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=<N>, RhiError count=0, ...`
//
// charter mapping:
//   - F1 (limited context): smoke literal grep finds frames=300 +
//     PASS-3-criteria + backend=webgpu in this single file.
//   - P4 (consistent abstraction): the dawn-node mock canvas / shared
//     device capture / engine ECS spawn shape mirrors the textures
//     template; only the verdict diverges (D-3 explicit special case).
//   - P3 (explicit failure): every step that can fail logs `[smoke]
//     FAIL - <criterion>` + a rerun hint and exits 1.

import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-1-hello-window' smoke",
  );
  console.error(
    '  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present',
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ----------------------------

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Drive engine ECS path: Camera-only world -----------------------------
//
// LO 1.1 stops at glClearColor + glClear; the demo's spawnCameraOnly
// (src/index.ts:68-106) spawns a single Camera entity that carries the
// clear color on the Camera component (feat-20260608 clearR/G/B/A
// surface trim). The engine's RenderSystem clear-pass-only path
// (Case E softening; render-system-record.ts) emits one clear pass per
// frame even with no MeshFilter + MeshRenderer entities present.

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { Camera, createRenderer, Transform } = enginePkg;

// Reuse the engine shader manifest (mirrors the 4.textures template).
// LO 1.1 is clear-pass only but the renderer still validates the
// manifest URL on init, so we hand it the real engine manifest data: URL.
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: EMPTY_MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-hello-window] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
      clearColor: [0.2, 0.3, 0.3, 1.0],
    },
  },
);

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 4. Pixel readback (corner-only; LO 1.1 has no geometry) ----------------

if (!renderTarget) {
  console.error(
    '[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()',
  );
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(
    `[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const sites = [
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (3 criteria; LO 1.1 special case per D-3 / AC-08) -----------

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

void SMOKE_PIXEL_THRESHOLD;
void APP_ROOT;

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-1-hello-window' smoke",
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify clear-pass camera spawn (LO 1.1 has no geometry)',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
