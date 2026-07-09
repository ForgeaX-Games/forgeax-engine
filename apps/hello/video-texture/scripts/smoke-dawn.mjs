#!/usr/bin/env node
// apps/hello/video-texture headless dawn structural smoke
// (feat-20260623-world-space-video-asset M5 / w19).
//
// End-to-end structural proof: dawn-node drives the video-texture ECS path
// (VideoAsset register + VideoPlayer spawn + MeshFilter/MeshRenderer +
// MaterialAsset.paramValues referencing the video GUID), runs 300 frames,
// and exits 0 when the registration/spawn/bind-group chain does not throw.
//
// Dawn structural-only: dawn-node has NO HTMLVideoElement / VideoFrame, so
// video pixel upload is NOT exercised (that lives in the browser e2e, w21).
// This smoke validates that the video kind in the Asset union, the loader,
// the VideoPlayer component, the extract-stage videoTextureFields resolution,
// and the record-stage DynamicTextureStore routing all survive without
// crashing a dawn-node device.
//
// Strategy (mirrors hello-room smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + shim GPUCanvasContext.
//   3. Build a World identical to the browser demo: quad mesh + unlit
//      MaterialAsset with baseColorTexture=videoGuid + VideoPlayer clip.
//   4. await renderer.ready + 300x renderer.draw(world).
//   5. Verdict: backend===webgpu, frames>=300, draw errors===0.
//
// Exit codes:
//   0 = green (structural chain survived)
//   1 = red (crash / draw error)

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);

// Small canvas to keep lavapipe fragment-bound smoke fast.
const WIDTH = 200;
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/video-texture smoke');
  console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
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
  console.error('  rerun: pnpm --filter @forgeax/video-texture smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await origReqAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const origReqDev = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await origReqDev(desc);
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

// --- 3. Drive engine ECS path with video asset -------------------------------

import { readFileSync } from 'node:fs';

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = enginePkg;
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');
const { VideoPlayer } = await import('@forgeax/engine-graphics-extras');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(
  readFileSync(MANIFEST_PATH, 'utf8'),
)}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = origReqAdapter;
}

console.log(`[video-texture] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// --- 4. Register a video asset and an unlit material that samples from it ----

const videoGuidResult = AssetGuid.parse('f1b3d000-1111-4aaa-9eee-aa1111112222');
if (!videoGuidResult.ok) {
  console.error(`[smoke] FAIL - video GUID parse: ${videoGuidResult.error.code}`);
  process.exit(1);
}
const videoGuid = videoGuidResult.value;
assets.catalog(videoGuid, { kind: 'video', url: '/cutscene.webm' });

const videoHandleRes = await assets.loadByGuid(videoGuid);
if (!videoHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid video: ${videoHandleRes.error.code}`);
  process.exit(1);
}
console.log('[video-texture] VideoAsset registered and loaded');

// Unlit material whose baseColorTexture paramValue is the video GUID.
// The extract stage resolves the GUID to a video handle via resolveVideoFieldHandle,
// and the record stage routes it to DynamicTextureStore (dawn has no video element,
// so it will bind a default fallback view — the structural chain is the test).
const matGuidResult = AssetGuid.parse('b2b3d000-2222-4bbb-9eee-bb2222223333');
if (!matGuidResult.ok) {
  console.error(`[smoke] FAIL - material GUID parse: ${matGuidResult.error.code}`);
  process.exit(1);
}
assets.catalog(matGuidResult.value, {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues: {
    baseColor: [0.2, 0.5, 0.9],
    baseColorTexture: videoGuid,
  },
});

const matHandleRes = await assets.loadByGuid(matGuidResult.value);
if (!matHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid material: ${matHandleRes.error.code}`);
  process.exit(1);
}
console.log('[video-texture] video-textured material registered');

// --- 5. Build world: quad + camera + directional light + video player -------

const world = new World();

// NB: do NOT insert a VideoElementProvider — dawn has no HTMLVideoElement.
// The record stage's single per-frame upload path resolves element===undefined,
// hits the AC-10 double-miss, fires video-upload-unsupported on the engine error
// channel, and falls back to the default view — structurally valid, no crash.
// The verdict below filters that expected code out of the draw-error gate.

world.spawn(
  {
    component: Camera,
    // perspective() requires fov (RADIANS) + aspect; raw `{ fov: 60, near, far }`
    // would leave aspect=0 (degenerate projection) and treat 60 as radians.
    data: perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
  },
  { component: Transform, data: { pos: [0, 0, 5]} },
);
console.log('[video-texture] camera entity spawned');

world.spawn(
  {
    component: DirectionalLight,
    data: {
      directionX: -0.3,
      directionY: -1.0,
      directionZ: -0.5,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.5,
    },
  },
  { component: Transform, data: { pos: [1, 2, 1]} },
);
console.log('[video-texture] light entity spawned');

// Mint handles from the payloads that loadByGuid returned (loadByGuid
// returns the payload, not a handle — D-17). allocSharedRef maps payload
// to a per-world column handle for spawn.
const videoClipHandle = world.allocSharedRef('VideoAsset', videoHandleRes.value);
const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

const videoEnt = world.spawn(
  { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
  {
    component: VideoPlayer,
    data: { clip: videoClipHandle, playing: true, loop: true, currentTime: 0 },
  },
  {
    component: Transform,
    data: { pos: [0, 0, -1], scale: [2, 2, 1]},
  },
);
console.log(`[video-texture] video-textured quad entity spawned: ${String(videoEnt)}`);

// --- 6. Render loop ----------------------------------------------------------

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code} - ${r.error.hint}`);
  }
  framesObserved++;
}
const device = sharedDevice;
if (device) {
  await device.queue.onSubmittedWorkDone();
}
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 7. Verdict (structural: chain survived) ---------------------------------

const failures = [];
if (renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
}
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}
const drawErrors = errors.filter(
  (e) => !(e.code === 'video-upload-unsupported'),
);
if (drawErrors.length > 0) {
  const codes = drawErrors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${drawErrors.length} times (excluding video-upload-unsupported): [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - structural chain GREEN: backend=webgpu, frames=${framesObserved}, VideoAsset registered, VideoPlayer spawned, extract/record routing survived.`,
);

device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);