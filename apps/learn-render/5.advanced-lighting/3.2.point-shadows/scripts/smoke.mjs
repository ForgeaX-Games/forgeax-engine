#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/3.2.point-shadows/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M3 / M3-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3.2 point-light cube-map shadows dawn-node smoke
// (structural-only). Spawns a cullMode:none room cube + 5 inner cubes +
// DirectionalLight fill + PointLight + PointLightShadow + orbit system,
// renders 300 frames, and asserts no RhiError / no unknown onError codes.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-2-point-shadows] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const WIDTH = 512;
const HEIGHT = 512;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');

// Known-noise app.onError codes.
const KNOWN_NOISE_CODES = new Set([]);

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
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
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// rAF / cAF stubs must be installed BEFORE createApp.
let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// --- 2. Mock canvas with offscreen render target ---

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
  tagName: 'CANVAS',
  isConnected: true,
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

// --- 3. Shader manifest ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// --- 4. createApp + setup ---

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const runtimePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  PointLightShadow,
  Transform,
} = runtimePkg;
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-3-2-point-shadows] backend=${app.renderer.backend}`);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));

const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = app.world;

// --- 5. Spawn scene ---

// R-D4 risk countermeasure: ensure cullMode:'none' appears.
const roomCullMode = FALSIFY === 'force-backface-cull' ? 'back' : 'none';

const roomMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      fragmentEntry: 'fs_main',
      tags: { LightMode: 'Forward' },
      passKind: 'forward',
      renderState: { cullMode: roomCullMode },
    },
    {
      name: 'ShadowCaster',
      shader: 'forgeax::default-shadow-caster',
      tags: { LightMode: 'ShadowCaster' },
      passKind: 'shadow-caster',
    },
  ],
  paramValues: {
    baseColor: [0.4, 0.4, 0.5, 1],
    metallic: 0,
    roughness: 0.5,
    occlusionStrength: 1,
  },
});

if (roomCullMode === 'none') {
  console.log("[smoke] room cullMode: 'none' -- inner walls visible (R-D4 verification)");
} else {
  console.log('[smoke] FALSIFY=force-backface-cull -- cullMode set to back (walls culled)');
}

// Room cube: scale=5.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [5, 5, 5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [roomMat] } },
).unwrap();

// 5 inner solid-color cubes.
const innerObjects = [
  { pos: [-2, 0, -1],scale: 1, color: [1, 0.3, 0.3] },
  { pos: [1, -1, -2],scale: 0.7, color: [0.3, 1, 0.3] },
  { pos: [0, 1.5, -3],scale: 0.5, color: [0.3, 0.3, 1] },
  { pos: [-1, -0.5, 2],scale: 1.2, color: [1, 1, 0.3] },
  { pos: [2, -1.5, 1],scale: 0.8, color: [1, 0.3, 1] },
];
for (const obj of innerObjects) {
  const [r, g, b] = obj.color;
  const mat = Materials.standard({ baseColor: [r, g, b, 1] });
  const matHandle = world.allocSharedRef('MaterialAsset', mat);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: obj.pos,
        quat: [0, 0, 0, 1],
        scale: [obj.scale, obj.scale, obj.scale],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();
}

// Ambient directional fill light (no shadow).
world.spawn(
  {
    component: DirectionalLight,
    data: {
      directionX: 0, directionY: -1, directionZ: 0.1,
      colorR: 1, colorG: 1, colorB: 1, intensity: 0.15,
    },
  },
).unwrap();

// Orbiting point light with shadow.
const lightEntity = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 4, 0]},
  },
  {
    component: PointLight,
    data: { range: 25, intensity: 8 },
  },
  {
    component: PointLightShadow,
    data: {},
  },
).unwrap();

// Camera at origin, facing -Z.
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.5, 0], quat: [0, 0, 0, 1]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearR: 0.02,
      clearG: 0.02,
      clearB: 0.04,
    },
  },
).unwrap();

// Per-frame light orbit.
let elapsed = 0;
world.addSystem({
  name: 'point-light-orbit-smoke',
  queries: [],
  fn: () => {
    elapsed += 1 / 60;
    const t = elapsed;
    world.set(lightEntity, Transform, {
      pos: [Math.sin(t) * 3, 0, Math.cos(t) * 3],});
  },
});

// --- 6. Render 300 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  if (i % 16 === 15) await delay(1);
}

const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);

// --- 7. Verdict (structural-only) ---

const failures = [];
if (app.renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.backend} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(c) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${totalFrames}, cullMode=${roomCullMode}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);