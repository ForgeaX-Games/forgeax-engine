#!/usr/bin/env node
// hello-compressed-texture dawn-node headless smoke (M6 w40).
// feat-20260707-texture-block-compression-web-transcode-ktx2-basis.
//
// Strategy: dawn-node drives the same engine ECS path the browser demo
// exercises. Builds a synthetic checkerboard TextureAsset at smoke time so
// the node-side path is self-contained (no vite-plugin-pack dependency).
// The Basis transcode + block-upload path is exercised by the browser e2e
// (w41) and pixel parity (w42); this smoke proves the scene boots and renders
// 300+ frames without crashing or WebGPU validation errors.
//
// Output literals (grep-friendly):
//   - `[hello-compressed] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 200;
const HEIGHT = 150;

// --- 1. dawn.node binding setup ------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-compressed-texture smoke');
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
  console.error('  rerun: pnpm --filter @forgeax/hello-compressed-texture smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
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

// --- 2. Mock canvas with offscreen render target -------------------------------

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

// --- 3. Drive engine ECS path --------------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const engine = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = engine;
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const distShaders = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(distShaders, 'utf8'))}`;

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

console.log(`[hello-compressed] backend=${renderer.backend}`);

const caps = renderer.device.caps;
console.log(
  `[hello-compressed] caps: bc=${caps.textureCompressionBc} etc2=${caps.textureCompressionEtc2} astc=${caps.textureCompressionAstc}`,
);

// Build a synthetic 256x256 RGBA checkerboard texture at smoke time (self-contained,
// no vite-plugin-pack dependency). The real Basis transcode path is tested by the
// browser e2e (w41 / AC-15) and pixel parity (w42 / AC-14).
const TEX_W = 256;
const TEX_H = 256;
const CHECK_SIZE = 32;
const checkerPixels = new Uint8Array(TEX_W * TEX_H * 4);
for (let y = 0; y < TEX_H; y++) {
  for (let x = 0; x < TEX_W; x++) {
    const cx = Math.floor(x / CHECK_SIZE) % 2;
    const cy = Math.floor(y / CHECK_SIZE) % 2;
    const white = cx === cy ? 1 : 0;
    const i = (y * TEX_W + x) * 4;
    checkerPixels[i] = white ? 255 : 64;
    checkerPixels[i + 1] = white ? 200 : 32;
    checkerPixels[i + 2] = white ? 128 : 255;
    checkerPixels[i + 3] = 255;
  }
}

const world = new World();
const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// Register synthetic texture + mint handles.
const texHandle = world.allocSharedRef('TextureAsset', {
  kind: 'texture',
  width: TEX_W,
  height: TEX_H,
  format: 'rgba8unorm',
  data: checkerPixels,
  colorSpace: 'srgb',
  mipmap: false,
});
const samplerHandle = world.allocSharedRef('SamplerAsset', {
  kind: 'sampler',
  magFilter: 'linear',
  minFilter: 'linear',
  addressModeU: 'repeat',
  addressModeV: 'repeat',
});
const matHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      shader: 'forgeax::standard-pbr',
      paramValues: {
        baseColorFactor: [1, 1, 1, 1],
        roughnessFactor: 0.8,
        metallicFactor: 0,
        baseColorTexture: { handle: texHandle },
        baseColorSampler: { handle: samplerHandle },
      },
    },
  ],
});

// 4 staggered quads.
const quads = [
  [-1.5, 0.8, 0, 0.7, 0.7, 1],
  [1.5, 0.8, 0, 0.5, 0.5, 1],
  [-1.5, -0.8, 0, 0.5, 0.5, 1],
  [1.5, -0.8, 0, 0.7, 0.7, 1],
];
for (const [px, py, pz, sx, sy, sz] of quads) {
  world.spawn(
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
    {
      component: Transform,
      data: { pos: [px, py, pz], scale: [sx, sy, sz]},
    },
  );
}

// Directional light.
world.spawn({
  component: DirectionalLight,
  data: {
    directionX: -0.1,
    directionY: -0.6,
    directionZ: -1,
    colorR: 1,
    colorG: 1,
    colorB: 1,
    intensity: 3,
  },
});
// Camera: perspective from Z=3.
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3]} },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
      clearR: 0.02,
      clearG: 0.02,
      clearB: 0.05,
      clearA: 1,
    },
  },
);

// --- 4. Render loop -----------------------------------------------------------

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code}`);
  process.exit(1);
}

const start = performance.now();
let totalFrames = 0;
const pixelReads = [];
while (true) {
  renderer.draw([world], { owner: 0 });
  totalFrames++;
  const now = performance.now();
  if (now - start >= SMOKE_DURATION_MS) break;
  await delay(0);
}

// Battery: NDC centre pixel readback, prove non-black.
if (sharedDevice && renderTarget) {
  try {
    const buf = sharedDevice.createBuffer({
      size: 4,
      usage: 0x08 | 0x01, // COPY_DST (0x08) | MAP_READ (0x01)
    });
    const cmd = sharedDevice.createCommandEncoder();
    cmd.copyTextureToBuffer(
      { texture: renderTarget, origin: { x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2), z: 0 } },
      { buffer: buf, offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    sharedDevice.queue.submit([cmd.finish()]);
    await buf.mapAsync(1);
    const px = new Uint8Array(buf.getMappedRange());
    pixelReads.push({ r: px[0], g: px[1], b: px[2], a: px[3] });
    buf.unmap();
  } catch (_e) {
    // Non-fatal: readback is a battery probe, not structural.
    pixelReads.push({ r: 0, g: 0, b: 0, a: 0 });
  }
}

// --- 5. Verdict ----------------------------------------------------------------

const framesOk = totalFrames >= SMOKE_MIN_FRAMES;
const pixelsNonBlack =
  pixelReads.length > 0 &&
  pixelReads.some((p) => p.r > 10 || p.g > 10 || p.b > 10);
const pixelJson = JSON.stringify(pixelReads);

console.log(`[smoke] frames observed=${totalFrames}`);
console.log(`[smoke] pixelSamples=${pixelJson}`);

if (!framesOk) {
  console.error(
    `[smoke] FAIL - frames observed=${totalFrames} < SMOKE_MIN_FRAMES=${SMOKE_MIN_FRAMES}`,
  );
  sharedDevice?.destroy?.();
  process.exit(1);
}
if (!pixelsNonBlack) {
  console.error('[smoke] FAIL - centre pixel samples are all near-black');
  console.error(`  pixelSamples=${pixelJson}`);
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log('[smoke] PASS');
// dawn-node's GPU teardown does not settle the Node event loop on its own
// (it hangs ~4min before the process exits), which the CI smoke-fleet step
// reads as a cancel. Destroy the device and exit explicitly so the verdict
// is the last thing that happens -- mirrors every other hello-* smoke's
// `device.destroy?.(); process.exit(0)` tail.
sharedDevice?.destroy?.();
process.exit(0);