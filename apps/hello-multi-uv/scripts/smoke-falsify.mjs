#!/usr/bin/env node
// smoke-falsify.mjs -- feat-20260629-multi-uv-set-support m5-w4
//
// Visual falsification variant for AC-10. Constructs the same 2-UV-set
// procedural plane but swaps uv1 = uv0 in the interleaved buffer,
// effectively replacing every checkerboard uv1 value with the uniform
// grid uv0. The expected outcome is that the visual differentiation
// (maxDiff across quad samples) drops below the threshold -- confirming
// that the AC-10 smoke signal genuinely comes from uv1 data, not from
// unrelated rendering noise.
//
// This script does NOT run in CI (plan-strategy §5.4). It is executed
// manually during M5 implement to verify falsification sensitivity.
//
// Accepted outcomes:
//   (a) FAIL_WITH_LOW_DIFF: maxDiff < 0.03 -- uv1 swap killed the
//       checkerboard variation; AC-10 smoke is falsifiable. CORRECT.
//   (b) PASS_WITH_HIGH_DIFF: maxDiff >= 0.03 despite the swap -- means
//       the checkerboard difference was not from uv1 data; AC-10
//       must be arbitrated by human Read(image). DEGENERATE.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = 300;
const SMOKE_PIXEL_THRESHOLD = 0.05;

const WIDTH = 200;
const HEIGHT = 150;

// --- dawn.node ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[falsify-smoke] FAIL - dawn.node import failed: ${err}`);
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
  console.error(`[falsify-smoke] FAIL - dawn-node create([]) failed: ${err}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const origReqDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await origReqDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- mock canvas ---

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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- build 2-UV plane mesh (WITH FALSIFICATION: uv1 = uv0 swap) ---

const HALF_W = 1.5;
const HALF_H = 1.5;
const GRID_X = 4;
const GRID_Y = 4;
const VX = GRID_X + 1;
const VY = GRID_Y + 1;
const UV_SETS = 2;
const FLOATS_BASE = 12;
const FLOATS_PER_VERTEX = FLOATS_BASE + (UV_SETS - 1) * 2;

const vertexCount = VX * VY;
const indexCount = GRID_X * GRID_Y * 6;
const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
const indices = new Uint16Array(indexCount);
const segW = (HALF_W * 2) / GRID_X;
const segH = (HALF_H * 2) / GRID_Y;

for (let iy = 0, vi = 0; iy < VY; iy++) {
  for (let ix = 0; ix < VX; ix++, vi++) {
    const x = ix * segW - HALF_W;
    const y = -(iy * segH - HALF_H);
    const b = vi * FLOATS_PER_VERTEX;
    vertices[b + 0] = x;
    vertices[b + 1] = y;
    vertices[b + 2] = 0;
    vertices[b + 3] = 0;
    vertices[b + 4] = 0;
    vertices[b + 5] = 1;
    const gridU = ix / GRID_X;
    const gridV = iy / GRID_Y;
    vertices[b + 6] = gridU;
    vertices[b + 7] = gridV;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
    // FALSIFICATION: swap uv1 = uv0 (instead of checkerboard)
    vertices[b + 12] = gridU;
    vertices[b + 13] = gridV;
  }
}

for (let iy = 0, ii = 0; iy < GRID_Y; iy++) {
  for (let ix = 0; ix < GRID_X; ix++) {
    const a = ix + VX * iy;
    const b = ix + VX * (iy + 1);
    const c = ix + 1 + VX * (iy + 1);
    const d = ix + 1 + VX * iy;
    indices[ii++] = a;
    indices[ii++] = b;
    indices[ii++] = d;
    indices[ii++] = b;
    indices[ii++] = c;
    indices[ii++] = d;
  }
}

const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const uvs = new Float32Array(vertexCount * 2);
const tangents = new Float32Array(vertexCount * 4);
const uv1 = new Float32Array(vertexCount * 2);
for (let i = 0; i < vertexCount; i++) {
  const b = i * FLOATS_PER_VERTEX;
  positions[i * 3 + 0] = vertices[b + 0];
  positions[i * 3 + 1] = vertices[b + 1];
  positions[i * 3 + 2] = vertices[b + 2];
  normals[i * 3 + 0] = vertices[b + 3];
  normals[i * 3 + 1] = vertices[b + 4];
  normals[i * 3 + 2] = vertices[b + 5];
  uvs[i * 2 + 0] = vertices[b + 6];
  uvs[i * 2 + 1] = vertices[b + 7];
  tangents[i * 4 + 0] = vertices[b + 8];
  tangents[i * 4 + 1] = vertices[b + 9];
  tangents[i * 4 + 2] = vertices[b + 10];
  tangents[i * 4 + 3] = vertices[b + 11];
  uv1[i * 2 + 0] = vertices[b + 12];
  uv1[i * 2 + 1] = vertices[b + 13];
}

console.log('[falsify-smoke] uv1 data swapped to uv0 values -- checkerboard should vanish');

// --- drive engine ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { Camera, createRenderer, DirectionalLight, MeshFilter, MeshRenderer, Transform } = enginePkg;

const world = new World();
const __MESH_ID = 100;
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 0.5, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: MeshFilter, data: { assetHandle: __MESH_ID } },
  { component: MeshRenderer, data: {} },
);
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 3, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { directionX: -0.3, directionY: -0.8, directionZ: -1, colorR: 1, colorG: 1, colorB: 1, intensity: 1 },
});

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
let MANIFEST_URL;
try {
  MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
} catch {
  console.error('[falsify-smoke] FAIL - manifest.json not found. Run: pnpm --filter @forgeax/hello-multi-uv build first');
  process.exit(1);
}

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[falsify-smoke] FAIL - createRenderer threw: ${err}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[falsify-smoke] FAIL - renderer.ready: ${ready.error.code}`);
  process.exit(1);
}

renderer.assets.catalog('guid:0a0a0a0a-0000-0000-0000-0a0a0a0a0a0a', {
  kind: 'mesh',
  vertices,
  indices,
  attributes: { position: positions, normal: normals, uv: uvs, tangent: tangents, uv1 },
  submeshes: [{ indexOffset: 0, indexCount: indices.length, vertexCount, topology: 'triangle-list' }],
  aabb: new Float32Array([-HALF_W, -HALF_H, -0.01, HALF_W, HALF_H, 0.01]),
});
renderer.assets.catalog('guid:1b1b1b1b-0000-0000-0000-1b1b1b1b1b1b', {
  kind: 'material',
  passes: [{ name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 }],
  paramValues: { baseColor: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8 },
});

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const r = renderer.draw(world);
  if (!r.ok) console.error(`[falsify-smoke] draw frame ${i} error: ${r.error.code}`);
}
await sharedDevice.queue.onSubmittedWorkDone();

// --- readback ---

const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
const rbBuf = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = sharedDevice.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: rbBuf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([enc.finish()]);
}
await rbBuf.mapAsync(0x01);
const mapped = rbBuf.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
rbBuf.unmap();
rbBuf.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [(bytes[off + 0] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};

const samples = [
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.6)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.6)),
];

const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const maxDiff = Math.max(
  dist(samples[0], samples[1]), dist(samples[0], samples[2]),
  dist(samples[0], samples[3]), dist(samples[1], samples[2]),
  dist(samples[1], samples[3]), dist(samples[2], samples[3]),
);

console.log(`[falsify-smoke] quadSamples=${JSON.stringify(samples)}`);
console.log(`[falsify-smoke] maxDiff=${maxDiff.toFixed(4)}`);

sharedDevice.destroy?.();
delete globalThis.navigator.gpu;

// Falsification verdict: when uv1==uv0, the PBR shader multiplies albedo by
// (uv1*0.5+0.5) = (uv0*0.5+0.5) -- a modulation based solely on the uniform
// grid uv0. The checkerboard pattern is gone, so pixel variance across grid
// regions should be very low.
if (maxDiff < 0.03) {
  console.log('[falsify-smoke] PASS_FALSIFY - uv1 swap killed checkerboard variance (maxDiff < 0.03). AC-10 smoke is falsifiable.');
  process.exit(0);
} else {
  console.log(`[falsify-smoke] FAIL_FALSIFY - uv1 swap did NOT kill checkerboard variance (maxDiff=${maxDiff.toFixed(4)} >= 0.03).`);
  console.log('[falsify-smoke] AC-10 smoke signal is NOT sensitive to uv1 data. Human Read(image) arbitration required.');
  process.exit(1);
}