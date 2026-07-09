#!/usr/bin/env node
// apps/learn-render/1.getting-started/3.shaders/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 1.3 shaders dawn-node smoke (feat-20260611 w9 / M3
// round-2 fix-up I-1 -- real-scene adaptation per src/index.ts). Walks
// the same engine ECS path as the demo rather than reusing the
// hello-triangle smoke shape:
//
//   src/index.ts (LO 1.3) drives a single triangle via builtin
//   HANDLE_TRIANGLE + a passes-form MaterialAsset that carries the
//   forgeax::default-unlit shader pass and a baseColor paramValue.
//   The runtime plumbs paramValues through to the unlit pipeline; the
//   on-screen colour is the LO 1.3 teaching colour vec4(1, 0.5, 0.2, 1).
//
// Differential axes vs hello-triangle (D-2 / D-8 byte-level):
//   - GUID set: builtin HANDLE_TRIANGLE only, ZERO loadByGuid + ZERO
//     registerWithGuid (matches src/index.ts: `loadByGuid=0
//     registerWithGuid=0` -- no asset chain wired in 1.3).
//   - Material form: passes-form (`passes:[{shader: 'forgeax::default-
//     unlit'}]` + `paramValues: {baseColor: PLAY_BASE_COLOR}`) -- LO 1.3
//     introduces this surface (vs hello-triangle's flat shadingModel
//     form). Smoke uses the asset.register Result-returning surface.
//   - clear color: engine teal default (0.2, 0.3, 0.3) -- src/index.ts
//     does not override `defaultClear`.
//   - sample sites: single triangle at NDC origin -- centre + apex
//     (top) + baseLeft + baseRight + cornerTL/BR. Names mirror the LO
//     1.3 single-triangle geometry, NOT a cube (cubeUL would be a lie).
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-shaders] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS - 4 criteria GREEN: ...`

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

// LO 1.3 teaching colour, mirrored from src/index.ts:
//   const PLAY_BASE_COLOR = [1.0, 0.5, 0.2, 1.0]
const PLAY_BASE_COLOR = [1.0, 0.5, 0.2, 1.0];

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-3-shaders' smoke",
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

// --- 3. Drive engine ECS path: HANDLE_TRIANGLE + passes-form unlit material -

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  HANDLE_TRIANGLE,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;

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

console.log(`[learn-render-shaders] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null (renderer construction did not complete successfully)');
  process.exit(1);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
// LO 1.3 passes-form material (mirrors src/index.ts spawnPulseScene):
// mint a user-tier column handle from the passes-form MaterialAsset POD
// (M8 D-17). The shader pass is what the unlit pipeline picks up. The
// smoke does not call computePulse(): pulse is rAF-driven in main.ts and
// is not part of the static frame verdict.
const playMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues: { baseColor: PLAY_BASE_COLOR },
});
// LO 1.3 single triangle at origin / identity rotation / unit scale.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0,
      posY: 0,
      posZ: 0,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
  {
    component: MeshRenderer,
    data: { materials: [playMaterial] },
  },
);
// Camera pulled back to z=3 to frame the canonical LO 1.3 NDC triangle.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0,
      posY: 0,
      posZ: 3,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
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

// --- 4. Pixel readback (multi-site grid) ------------------------------------

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
// LO 1.3 single equilateral triangle interior probes -- distinct from
// hello-triangle's triLeft/triRight; we add triApex (top) + triBaseL/R
// to anchor the LO 1.3 fragment colour at three triangle interior
// positions covering the geometry's vertical extent.
const sites = [
  { name: 'triCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'triApex', x: Math.floor(WIDTH * 0.5), y: Math.floor(HEIGHT * 0.42) },
  { name: 'triBaseL', x: Math.floor(WIDTH * 0.42), y: Math.floor(HEIGHT * 0.6) },
  { name: 'triBaseR', x: Math.floor(WIDTH * 0.58), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (4 criteria) ------------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['triCenter', 'triApex', 'triBaseL', 'triBaseR'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

void APP_ROOT;

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) LO 1.3 passes-form unlit triangle - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} distance from clear color; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-3-shaders' smoke",
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify HANDLE_TRIANGLE + passes-form unlit material registration (PLAY_BASE_COLOR=[1, 0.5, 0.2, 1])',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, LO 1.3 triangle interior sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
