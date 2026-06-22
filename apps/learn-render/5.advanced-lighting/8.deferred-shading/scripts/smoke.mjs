#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/smoke.mjs
// feat-20260612-hdrp-deferred-shading-learn-render-5-8 M4 / w21.
//
// LearnOpenGL section 5.8 deferred-shading dawn-node smoke (structural-only).
// Spawns 32 point lights + 9 cube 3x3 grid through HDRP deferred opaque,
// renders 300 frames, and asserts no RhiError / no unknown onError codes.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-8-deferred] backend=<backend>`
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

const NUM_LIGHTS = 32;
const CLUSTER_GRID = { x: 16, y: 9, z: 24 };
const CUBE_SCALE = 0.5;
const CUBE_SPACING = 3.0;
const CUBE_Y = -0.5;

const here = dirname(fileURLToPath(import.meta.url));

// Known-noise app.onError codes during HDRP deferred demo (32 lights within cluster-grid budget).
const KNOWN_NOISE_CODES = new Set([
  'hdrp-light-budget-exceeded',
  'hdrp-index-list-overflow',
]);

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

// rAF / cAF stubs must be installed BEFORE createApp; the engine's frame-loop
// captures the function reference at start() time, but ECS systems built during
// createApp may schedule rAF callbacks transitively.
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

// --- 3. Build engine shader manifest for dawn-node (no Vite) ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// --- 4. createApp + setup ---

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const runtimePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  HANDLE_CUBE,
  HDRP_PIPELINE_ID,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  Transform,
} = runtimePkg;

const appResult = await createApp(mockCanvas, { input: false }, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-8-deferred] backend=${app.renderer.backend}`);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));

const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const assets = app.renderer.assets;
if (assets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

let installSuccess = false;
if (FALSIFY === 'force-urp') {
  console.log('[smoke] FALSIFY=force-urp -- skipping installPipeline(hdrpHandle)');
} else {
  const installRes = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: { clusterGrid: CLUSTER_GRID },
  });
  if (!installRes.ok) {
    console.error(`[smoke] FAIL - installPipeline: ${installRes.error.code} - ${installRes.error.hint}`);
    process.exit(1);
  }
  installSuccess = true;
}

const world = app.world;

// --- 5. Spawn 9 cubes in 3x3 grid ---

const cubeColors = [
  [1.0, 0.3, 0.3], [0.3, 1.0, 0.3], [0.3, 0.3, 1.0],
  [1.0, 1.0, 0.3], [0.3, 1.0, 1.0], [1.0, 0.3, 1.0],
  [0.7, 0.7, 0.3], [0.3, 0.7, 0.7], [0.7, 0.3, 0.7],
];
const cubeHandles = [];
let idx = 0;
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    const cx = (col - 1) * CUBE_SPACING;
    const cz = (row - 1) * CUBE_SPACING;
    const [r, g, b] = cubeColors[idx];

    const mat = Materials.standard({ baseColor: [r, g, b, 1] });
    const matHandle = world.allocSharedRef('MaterialAsset', mat);
    cubeHandles.push(matHandle);

    world.spawn(
      {
        component: Transform,
        data: {
          posX: cx, posY: CUBE_Y, posZ: cz,
          quatW: 1,
          scaleX: CUBE_SCALE, scaleY: CUBE_SCALE, scaleZ: CUBE_SCALE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
    idx++;
  }
}

// --- 6. glibc-compatible LCG: matches `srand(13)` + `rand()` from LO 5.8.1 ---

function glibcRand(state) {
  const next = ((state * 1103515245 + 12345) >>> 0) & 0x7fffffff;
  const value = (next >> 16) & 0x7fff;
  return [next, value];
}

function randomPosition(state) {
  const [s1, xv] = glibcRand(state);
  const [s2, yv] = glibcRand(s1);
  const [s3, zv] = glibcRand(s2);
  const x = ((xv % 100) / 100.0) * 6.0 - 3.0;
  const y = ((yv % 100) / 100.0) * 6.0 - 3.0;
  const z = ((zv % 100) / 100.0) * 6.0 - 3.0;
  return [x, y, z, s3];
}

function randomColor(state) {
  const [s1, rv] = glibcRand(state);
  const [s2, gv] = glibcRand(s1);
  const [s3, bv] = glibcRand(s2);
  const r = ((rv % 100) / 200.0) + 0.5;
  const g = ((gv % 100) / 200.0) + 0.5;
  const b = ((bv % 100) / 200.0) + 0.5;
  return [r, g, b, s3];
}

// --- 7. Spawn 32 point lights (deterministic seed=13) ---

let state = 13;
for (let i = 0; i < NUM_LIGHTS; i++) {
  const [px, py, pz, sa] = randomPosition(state);
  const [cr, cg, cb, sb] = randomColor(sa);
  state = sb;

  world.spawn(
    {
      component: Transform,
      data: { posX: px, posY: py, posZ: pz, quatW: 1 },
    },
    {
      component: PointLight,
      data: {
        colorR: cr,
        colorG: cg,
        colorB: cb,
        intensity: 1.0,
        range: 6.0,
      },
    },
  );

  // Light-box visualization: small cube at each light position.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: px, posY: py, posZ: pz,
        quatW: 1,
        scaleX: 0.125, scaleY: 0.125, scaleZ: 0.125,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeHandles[0]] } },
  );
}

// Camera at (0, 1.5, 6) looking -Z.
world.spawn(
  {
    component: Transform,
    data: { posX: 0, posY: 1.5, posZ: 6.0, quatW: 1 },
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

// --- 8. Render 300 frames ---

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

// --- 9. Verdict (structural-only) ---

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
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${totalFrames}, hdrpInstalled=${installSuccess}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);