#!/usr/bin/env node
// hello-fbx-cube structural-only dawn smoke (M3 / t37).
//
// 300 frames structural smoke: backend=webgpu, no draw errors.
// Pixel readback deferred to M5 (need GPU device hook).
//
// Output: `[smoke] PASS` or `[smoke] FAIL`.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const SMOKE_MIN_FRAMES = 300;
const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ---
let create, globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- 2. Mock canvas ---
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
  width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          globalThis.__fbxRenderTarget = null;
          return null;
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Engine + FBX import ---
const { World } = await import('@forgeax/engine-ecs');
const { Transform, MeshFilter, MeshRenderer, Camera, DirectionalLight, createRenderer } = await import('@forgeax/engine-runtime');
const { fbxImporter } = await import('@forgeax/engine-fbx');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = manifestExists(MANIFEST_PATH)
  ? `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`
  : '';

function manifestExists(p) {
  try { return readFileSync(p); return true; } catch { return false; }
}

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, MANIFEST_URL ? { shaderManifestUrl: MANIFEST_URL } : {});
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(`[hello-fbx-cube] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) { console.error('[smoke] FAIL - AssetRegistry null'); process.exit(1); }

// Import cube.fbx via fbxImporter. The importer honours the GUID import-stable
// iron law: it only emits sub-assets declared in ctx.subAssets[]. Read them from
// the meta sidecar (SSOT) so this smoke exercises the same declared-GUID path as
// the dev server / build pre-import, not a subAssets:[] shortcut that produces
// nothing.
const CUBE_FBX = resolve(here, '..', '..', '..', '..', 'forgeax-engine-assets', 'vendor', 'fbx-test', 'cube.fbx');
const CUBE_META = JSON.parse(readFileSync(`${CUBE_FBX}.meta.json`, 'utf8'));
let results;
try {
  results = await fbxImporter.import({
    source: CUBE_FBX,
    readSource: async () => ({ ok: true, value: new Uint8Array(0) }),
    readSibling: async () => ({ ok: false, error: { code: 'source-read-failed' } }),
    decodeImage: async () => ({ ok: false, error: { code: 'image-decode-failed' } }),
    subAssets: CUBE_META.subAssets,
    importSettings: {},
  });
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : String(err);
  console.error(`[smoke] FAIL - fbxImporter.import threw: ${code}`);
  process.exit(1);
}

const meshAsset = results.find((a) => a.kind === 'mesh');
const matAsset = results.find((a) => a.kind === 'material');
if (!meshAsset || !matAsset) {
  console.error('[smoke] FAIL - fbxImporter did not produce mesh/material');
  process.exit(1);
}

console.log(`[smoke] mesh vertices=${meshAsset.payload.vertices.length} submeshes=${meshAsset.payload.submeshes.length}`);

const world = new World();

// feat-20260614 M8: AssetRegistry register* deleted; mint user-tier column
// handles via world.allocSharedRef (bare Handle, not a Result).
const meshHandle = world.allocSharedRef('MeshAsset', meshAsset.payload);
const matHandle = world.allocSharedRef('MaterialAsset', matAsset.payload);
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 30, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { directionX: -0.5, directionY: -1, directionZ: -0.3, colorR: 1, colorG: 1, colorB: 1, intensity: 1 },
});

const errors = [];
renderer.onError((err) => errors.push(err.code));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code}`);
  process.exit(1);
}

let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const r = renderer.draw(world);
  if (!r.ok) {
    const code = r.error && typeof r.error === 'object' && 'code' in r.error ? r.error.code : 'unknown';
    errors.push(code);
  }
  framesObserved++;
}

console.log(`[smoke] frames=${framesObserved} errors=${errors.length}`);

// Structural gate
const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) failures.push(`(c) errors=${errors.join(',')}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}

console.log(`[smoke] PASS - backend=webgpu, frames=${framesObserved}, errors=0`);
process.exit(0);