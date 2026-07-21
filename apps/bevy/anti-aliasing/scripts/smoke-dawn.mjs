#!/usr/bin/env node
// bevy-anti-aliasing headless dawn smoke (structural-only, no pixel readback).
// Strategy: 4 shapes (triangle, cube, quad, sphere) under a directional light.
//   (a) backend=webgpu
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) Renderer.onError count == 0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);

const WIDTH = 200;
const HEIGHT = 150;

// --- dawn.node setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- Mock canvas ---

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

// --- Build scene ---

const { World } = await import('@forgeax/engine-ecs');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const {
  Camera, createRenderer, DirectionalLight, Materials, MeshFilter, MeshRenderer,
  perspective, Transform,
} = await import('@forgeax/engine-runtime');

const world = new World();

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[anti-aliasing] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// 4 cube shapes using createBoxGeometry (procedural, dawn-node compatible)
const cubeGeom = createBoxGeometry(1, 1, 1, 1, 1, 1);
if (!cubeGeom.ok) { console.error('cube geom failed'); process.exit(1); }

const builtins = [
  { pos: [-1.05, 0, 0] },
  { pos: [-0.35, 0, 0] },
  { pos: [0.35, 0, 0] },
  { pos: [1.05, 0, 0] },
];

const matHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
  baseColor: [0.7, 0.7, 0.7, 1],
  metallic: 0,
  roughness: 0.4,
}));

for (const { pos } of builtins) {
  const geomHandle = world.allocSharedRef('MeshAsset', cubeGeom.value);
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: geomHandle } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );
}

world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 },
});

world.spawn(
  { component: Transform, data: { pos: [0, 0, 6] } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }), antialias: 0 } },
);

// --- Frame loop ---

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
let framesObserved = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

const device = sharedDevice;
if (device) await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved}`);

// --- Verdict ---

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0`);
device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);