#!/usr/bin/env node
import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/2.lighting/3.materials/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 2.lighting 3.materials dawn-node smoke.
// Mirrors the 2.basic-lighting smoke shape with a single-cube scene
// (LO 3.1 original) and a time-varying PointLight color (sin waves per
// RGB channel, negatives clamped to 0). Verdict: at least one meshed
// sample site exceeds the clear-color threshold, proving the lit cube
// + lamp marker rendered non-empty pixels.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-materials] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 512;
const HEIGHT = 512;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-3-materials' smoke",
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

// --- 3. Build engine shader manifest for pbr + unlit pipelines ---

const { World } = await import('@forgeax/engine-ecs');
const {
  Camera,
  createRenderer,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Transform,
} = await import('@forgeax/engine-runtime');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// --- 4. Create renderer and scene ---

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-materials] backend=${renderer.backend}`);

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

// Register materials (mirrors src/index.ts scene setup).
// Single standard material with roughness ~0.3 (PBR equivalent of LO shininess=32).
// feat-20260614 M8 (D-15/D-17): pass-based MaterialAsset minted via allocSharedRef.
const objectBaseColor = [1.0, 0.5, 0.31, 1.0];

const objectMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues: {
    baseColor: [objectBaseColor[0], objectBaseColor[1], objectBaseColor[2]],
    metallic: 0.0,
    roughness: 0.3,
  },
});

const lampMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 }],
  paramValues: { baseColor: [1.0, 1.0, 1.0, 1.0] },
});

// Spawn the object cube at origin (LO: model = identity).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [objectMatHandle] } },
  )
  .unwrap();

// LO lamp position (1.2, 1.0, 2.0). Lamp visual + PointLight share one
// entity so the lamp's Transform drives both the marker position and the
// light's world-space position via the [Transform, PointLight] query.
const LPX = 1.2, LPY = 1.0, LPZ = 2.0;
const lightEntity = world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [LPX, LPY, LPZ], quat: [0, 0, 0, 1], scale: [0.2, 0.2, 0.2],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [lampMatHandle] } },
    {
      component: PointLight,
      data: {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        range: Number.POSITIVE_INFINITY,
      },
    },
  )
  .unwrap();

// ECS system: animate light color (sin per channel, negatives clamped).
// Same frequencies and dt as src/index.ts.
let elapsed = 0;
const DT = 0.016;
const FREQ_R = 2.0, FREQ_G = 0.7, FREQ_B = 1.3;
world.addSystem(Update, {
  name: 'animated-light-color',
  queries: [],
  fn: () => {
    elapsed += DT;
    const colorR = Math.max(0, Math.sin(elapsed * FREQ_R));
    const colorG = Math.max(0, Math.sin(elapsed * FREQ_G));
    const colorB = Math.max(0, Math.sin(elapsed * FREQ_B));
    world.set(lightEntity, PointLight, { color: [colorR, colorG, colorB] });
  },
});

// Spawn static camera (LO: Camera(0,0,3) Zoom=45 deg).
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update(1 / 60).unwrap();
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

// --- 6. Pixel readback ---

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({
  size: bytesPerRow * HEIGHT,
  usage: 0x01 | 0x08,
});
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
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeOffCenter', x: Math.floor(WIDTH * 0.4), y: Math.floor(HEIGHT * 0.55) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 7. Verdict ---

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.1, 0.1, 0.1];
const meshSiteNames = ['ndcCenter', 'cubeOffCenter'];
let meshedCount = 0;
const perSite = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSite[name] = Number(dist.toFixed(4));
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSite)}`);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedCount < 1) {
  failures.push(
    `(c) 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} from clear color; perSite=${JSON.stringify(perSite)}`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-3-materials' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);