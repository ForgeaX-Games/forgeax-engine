#!/usr/bin/env node
// shadertoy/happy-blob headless smoke.
//
// Acceptance gate: the ported raymarcher must (a) run on the WebGPU backend,
// (b) produce a non-black frame (the creature fills the viewport), and (c)
// animate -- pixels measurably change as iTime advances.
//
// Strategy (mirrors hello/custom-shader smoke; charter P4 consistent
// abstraction):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + offscreen GPUCanvasContext.
//   3. createRenderer with the built shader manifest; read the composed wgsl
//      for shadertoy::happy-blob out of the manifest.
//   4. registerMaterialShader + spawn fullscreen quad + camera.
//   5. For t in {0.0, 0.6, 1.3} seconds: mutate paramValues.iTime, draw N
//      frames, copyTextureToBuffer + map, average the whole frame. Assert the
//      mean brightness is non-trivial and that frames differ across t.
//
// Output literals (preserved for grep-based tooling):
//   - `[happy-blob] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] meanBrightness=<json>`
//   - `[smoke] frameDelta_1=<num> delta_2=<num>`

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_FRAMES_PER_T = Number.parseInt(process.env.SMOKE_FRAMES_PER_T ?? '8', 10);
const MEAN_BRIGHTNESS_MIN = Number.parseFloat(process.env.MEAN_BRIGHTNESS_MIN ?? '0.002');
const FRAME_DELTA_MIN = Number.parseFloat(process.env.FRAME_DELTA_MIN ?? '0.002');

const WIDTH = 200;
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

// --- 1. dawn.node binding setup ---------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/shadertoy-happy-blob smoke');
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
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// Pin getPreferredCanvasFormat to 'rgba8unorm' so this harness's hardcoded
// rgba8unorm viewFormats stay compatible with dawn-node's UA preference.
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

// --- 3. Engine bootstrap ----------------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { Camera, createPlaneGeometry, createRenderer, MeshFilter, MeshRenderer, Transform } =
  enginePkg;

const MANIFEST_PATH = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
if (!existsSync(MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${MANIFEST_PATH}`);
  console.error('  hint: rebuild via `pnpm --filter @forgeax/shadertoy-happy-blob build`');
  process.exit(1);
}
const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8');
const manifestParsed = JSON.parse(manifestRaw);
const MANIFEST_URL = `data:application/json,${encodeURIComponent(manifestRaw)}`;

const matShaderEntry = (manifestParsed.materialShaders ?? []).find(
  (m) => m && typeof m.identifier === 'string' && m.identifier.includes('happy_blob'),
);
if (!matShaderEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing happy_blob entry');
  process.exit(1);
}
let composedWgsl;
if (
  matShaderEntry.composedWgsl.includes('\n') ||
  matShaderEntry.composedWgsl.startsWith('struct') ||
  matShaderEntry.composedWgsl.startsWith('//') ||
  matShaderEntry.composedWgsl.startsWith('@')
) {
  composedWgsl = matShaderEntry.composedWgsl;
} else {
  const composedWgslPath = resolve(
    appRoot,
    'dist',
    'shaders',
    matShaderEntry.composedWgsl.replace(/^\.\//, ''),
  );
  if (!existsSync(composedWgslPath)) {
    console.error(`[smoke] FAIL - composed wgsl sidecar missing at ${composedWgslPath}`);
    process.exit(1);
  }
  composedWgsl = readFileSync(composedWgslPath, 'utf8');
}

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

console.log(`[happy-blob] backend=${renderer.backend}`);

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const shader = renderer.shader;
const assets = renderer.assets;
if (shader === null || assets === null) {
  console.error('[smoke] FAIL - renderer.shader or renderer.assets is null on dawn path');
  process.exit(1);
}

shader.registerMaterialShader('shadertoy::happy-blob', {
  source: composedWgsl,
  paramSchema: [
    { name: 'iResolution', type: 'vec2' },
    { name: 'iTime', type: 'f32' },
  ],
  bindingLayout: [],
});

const paramValues = {
  iResolution: [WIDTH, HEIGHT],
  iTime: 0,
};
const world = new World();
const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'shadertoy::happy-blob',
      tags: { LightMode: 'Forward' },
      queue: 2000,
      renderState: { cullMode: 'none' },
    },
  ],
  paramValues,
});

const planeRes = createPlaneGeometry(1, 1);
if (!planeRes.ok) {
  console.error(`[smoke] FAIL - createPlaneGeometry: ${planeRes.error.code}`);
  process.exit(1);
}
const planeMeshHandle = world.allocSharedRef('MeshAsset', planeRes.value);

world
  .spawn(
    { component: Transform, data: { posX: 0, posY: 0, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
    { component: MeshFilter, data: { assetHandle: planeMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 3, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

// --- 4. Drive 3 t-points + readback ----------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function captureFrameAtT(t) {
  paramValues.iTime = t;
  for (let i = 0; i < SMOKE_FRAMES_PER_T; i++) {
    const r = renderer.draw(world);
    if (!r.ok) console.error(`[smoke] draw t=${t} frame ${i} error: ${r.error.code}`);
  }
  await device.queue.onSubmittedWorkDone();
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(0x01);
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  return bytes;
}

// Mean brightness across all pixels (RGB averaged, normalized to [0,1]).
function meanBrightness(bytes) {
  let sum = 0;
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const off = py * bytesPerRow + px * bytesPerPixel;
      sum += (bytes[off] ?? 0) + (bytes[off + 1] ?? 0) + (bytes[off + 2] ?? 0);
    }
  }
  return sum / (WIDTH * HEIGHT * 3 * 255);
}

// Mean per-pixel absolute difference between two frames (normalized to [0,1]).
function frameDelta(a, b) {
  let sum = 0;
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const off = py * bytesPerRow + px * bytesPerPixel;
      sum += Math.abs((a[off] ?? 0) - (b[off] ?? 0));
      sum += Math.abs((a[off + 1] ?? 0) - (b[off + 1] ?? 0));
      sum += Math.abs((a[off + 2] ?? 0) - (b[off + 2] ?? 0));
    }
  }
  return sum / (WIDTH * HEIGHT * 3 * 255);
}

let framesObserved = 0;
const frame0 = await captureFrameAtT(0.0);
framesObserved += SMOKE_FRAMES_PER_T;
const frame1 = await captureFrameAtT(0.6);
framesObserved += SMOKE_FRAMES_PER_T;
const frame2 = await captureFrameAtT(1.3);
framesObserved += SMOKE_FRAMES_PER_T;

console.log(`[smoke] frames observed=${framesObserved}`);

const b0 = meanBrightness(frame0);
const b1 = meanBrightness(frame1);
const b2 = meanBrightness(frame2);
console.log(
  `[smoke] meanBrightness=${JSON.stringify({ 't=0.0': b0, 't=0.6': b1, 't=1.3': b2 })}`,
);

const delta1 = frameDelta(frame0, frame1);
const delta2 = frameDelta(frame0, frame2);
console.log(`[smoke] frameDelta_1=${delta1.toFixed(5)} delta_2=${delta2.toFixed(5)}`);

// --- 5. Verdict -------------------------------------------------------------

const failures = [];
if (renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
}
const maxBrightness = Math.max(b0, b1, b2);
if (maxBrightness < MEAN_BRIGHTNESS_MIN) {
  failures.push(
    `(b) maxMeanBrightness=${maxBrightness.toFixed(5)} < threshold=${MEAN_BRIGHTNESS_MIN}; frame is black (raymarch produced no visible output)`,
  );
}
const maxDelta = Math.max(delta1, delta2);
if (maxDelta < FRAME_DELTA_MIN) {
  failures.push(
    `(c) maxFrameDelta=${maxDelta.toFixed(5)} < threshold=${FRAME_DELTA_MIN}; animation not visible (iTime mutation did not change the frame)`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL -- ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('  rerun: pnpm --filter @forgeax/shadertoy-happy-blob smoke');
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS -- backend=webgpu, frames=${framesObserved}, maxMeanBrightness=${maxBrightness.toFixed(5)}>=${MEAN_BRIGHTNESS_MIN}, maxFrameDelta=${maxDelta.toFixed(5)}>=${FRAME_DELTA_MIN}, RhiError count=0`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
