#!/usr/bin/env node
import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/5.advanced-lighting/3.2.point-shadows/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M3 / M3-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3.2 point-light cube-map shadows dawn-node smoke
// Spawns a cullMode:none room cube (scale=10 contains every witness cube) + 5 inner cubes + DirectionalLight fill +
// PointLight + PointLightShadow + orbit system, renders 300 frames, reads back
// the final render target, and asserts a producer-owned point-light witness.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-2-point-shadows] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const POINT_LIGHT_MIN_DELTA = Number.parseFloat(process.env.POINT_LIGHT_MIN_DELTA ?? '0.05');
const FALSIFY = process.env.FALSIFY ?? '';
const FALSIFY_NO_POINT_LIGHT = FALSIFY === 'no-point-light';
const WIDTH = 512;
const HEIGHT = 512;
const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

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
const { Materials, PointLightShadow } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective, PointLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
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
      program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' },
      renderState: { cullMode: roomCullMode, tags: { LightMode: 'Forward' } },
    },
    {
      name: 'ShadowCaster',
      program: { module: 'forgeax::default-shadow-caster' },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ],
  values: {
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

// Room cube: scale=10 so the unit cube's half-extent contains every witness object.
world.spawn(
  {
    component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [10, 10, 10]},
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
      direction: [0, -1, 0.1],
      color: [1, 1, 1], intensity: 0.15,
    },
  },
).unwrap();

// Orbiting point light with shadow.
let lightEntity = null;
if (!FALSIFY_NO_POINT_LIGHT) {
  lightEntity = world.spawn(
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
} else {
  console.log('[smoke] FALSIFY=no-point-light -- PointLight and PointLightShadow omitted');
}

// Camera at origin, facing -Z into the room.
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.5, 0], quat: [0, 0, 0, 1]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.02, 0.02, 0.04, 1],
    },
  },
).unwrap();

// Per-frame light orbit.
if (lightEntity !== null) {
  let elapsed = 0;
  world.addSystem(Update, {
    name: 'point-light-orbit-smoke',
    queries: [],
    fn: () => {
      elapsed += 1 / 60;
      const t = elapsed;
      world.set(lightEntity, Transform, {
        pos: [Math.sin(t) * 3, 4, Math.cos(t) * 3],});
    },
  });
}

// --- 6. Render 300 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const frameStart = Date.now();
let totalFrames = 0;
app.renderer.attachWorld(world).unwrap();
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const drawResult = app.renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
  if (!drawResult.ok) console.error(`[smoke] draw frame ${i} error: ${drawResult.error.code}`);
  totalFrames++;
  // Await each frame so async shadow/material PSOs can resolve before the
  // final readback; a tight rAF drain otherwise records only skip-draw frames.
  if (sharedDevice) await sharedDevice.queue.onSubmittedWorkDone();
  if (i % 16 === 15) await delay(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);

// --- 7. Pixel readback ------------------------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
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
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [
    (bytes[off + 0] ?? 0) / 255,
    (bytes[off + 1] ?? 0) / 255,
    (bytes[off + 2] ?? 0) / 255,
  ];
};
const sites = [
  { name: 'cubeCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeLower', x: Math.floor(WIDTH * 0.48), y: Math.floor(HEIGHT * 0.62) },
  { name: 'roomWall', x: Math.floor(WIDTH * 0.08), y: Math.floor(HEIGHT * 0.12) },
  { name: 'topCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.08) },
  { name: 'topLeft', x: Math.floor(WIDTH * 0.12), y: Math.floor(HEIGHT * 0.08) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

let maxChannel = 0;
let maxPixel = [0, 0];
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const sample = readRgba(x, y);
    const channel = Math.max(...sample);
    if (channel > maxChannel) {
      maxChannel = channel;
      maxPixel = [x, y];
    }
  }
}
console.log(`[smoke] maxChannel=${maxChannel.toFixed(4)} at=${JSON.stringify(maxPixel)}`);
const maxGrid = [];
for (let gy = 0; gy < 4; gy++) {
  const row = [];
  for (let gx = 0; gx < 4; gx++) {
    let cellMax = 0;
    for (let y = gy * HEIGHT / 4; y < (gy + 1) * HEIGHT / 4; y += 1) {
      for (let x = gx * WIDTH / 4; x < (gx + 1) * WIDTH / 4; x += 1) {
        cellMax = Math.max(cellMax, ...readRgba(x, y));
      }
    }
    row.push(Number(cellMax.toFixed(4)));
  }
  maxGrid.push(row);
}
console.log(`[smoke] maxGrid=${JSON.stringify(maxGrid)}`);

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lumSamples = Object.fromEntries(
  Object.entries(pixelSamples).map(([name, sample]) => [name, Number(luminance(sample).toFixed(4))]),
);
console.log(`[smoke] lumSamples=${JSON.stringify(lumSamples)}`);
const clearLuminance = luminance([0.02, 0.02, 0.04]);
const pointLightSite = Math.max(lumSamples.cubeCenter, lumSamples.topCenter, lumSamples.topLeft);
const pointLightWitness = pointLightSite - clearLuminance >= POINT_LIGHT_MIN_DELTA;
const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);
console.log(
  `[smoke] oracle=point-light-shadow siteLuminance=${pointLightSite} deltaFromClear=${Number((pointLightSite - clearLuminance).toFixed(4))} witness=${pointLightWitness} threshold=${POINT_LIGHT_MIN_DELTA} falsifier=${FALSIFY_NO_POINT_LIGHT ? 'no-point-light' : 'none'}`,
);

// --- 8. Verdict -------------------------------------------------------------

const failures = [];
if (app.renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.backend} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

if (roomCullMode !== 'none') {
  failures.push(`(c) room cullMode=${roomCullMode}; expected cullMode=none for inner-wall visibility`);
}

if (pointLightSite - clearLuminance < SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(d) brightest semantic site luminance=${pointLightSite} ~= clear (${clearLuminance.toFixed(4)}); room/cube not rendered`,
  );
}
if (!pointLightWitness) {
  failures.push(
    `(e) point-light shadow witness rejected siteLuminance=${pointLightSite}; expected deltaFromClear>=${POINT_LIGHT_MIN_DELTA}`,
  );
}
if (wallTotalMs > SMOKE_WALL_BUDGET_MS) {
  failures.push(`(f) wallTotalMs=${wallTotalMs} > ${SMOKE_WALL_BUDGET_MS}`);
}

const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(g) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(h) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
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
  `[smoke] PASS - 8 criteria GREEN: backend=webgpu, frames=${totalFrames}, cullMode=${roomCullMode}, cubeRendered, oracle=point-light-shadow, wallTotalMs=${wallTotalMs}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
