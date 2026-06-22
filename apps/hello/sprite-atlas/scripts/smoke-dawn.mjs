#!/usr/bin/env node
// hello-sprite-atlas headless smoke (feat-20260521-sprite-atlas-animation M6
// T-36; AC-07).
//
// Strategy (mirrors apps/hello/sprite/scripts/smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Register a synthetic 64x64 RGBA atlas texture with 4 colored
//      quadrants (2x2 grid, 32x32 each) + a default sampler so the
//      sprite material loads without a /pack-index.json fetch.
//   4. Build a fresh World + spawn 1 host entity with Instances(100) +
//      SpriteAnimation(4 frames loop) + SpriteRegionOverride + ortho
//      camera + 300 render frames + copyTextureToBuffer + mapAsync +
//      write or compare the reference PNG.
//   5. AC-07 passes when the single reference PNG sits within eps<=0.05
//      of its baseline. First-run writes the baseline and exits 1 with a
//      "WRITTEN" marker so CI / human review can force-add it then rerun.
//
// AC-07 metrics (RHI statistics):
//   - drawIndexed == 1 per frame (1 atlas / 100 instances -> 1 draw call)
//   - instanceCount == 100
//
// AC-07 path note (charter F2 + P5 producer/consumer split):
// - subagent runs this script and PRODUCES the PNGs; the main session
//   orchestrator READS the PNGs to verify the visual.
// - When the forgeax-engine-assets submodule is not initialised the
//   synthetic 4-quadrant atlas texture stands in.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeReferencePng, readReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const CLEAR_RGBA = [0.07, 0.07, 0.09, 1];
const INSTANCE_COUNT = 100;
const FRAME_COUNT = 4;
const FRAME_DURATION = 0.1;

const here = dirname(fileURLToPath(import.meta.url));
// Baseline PNG lives in the forgeax-engine-assets submodule
// (smoke-baselines/hello-sprite-atlas/) so the engine repo never tracks
// rendered binaries; mirrors hello-sprite smoke layout.
const BASELINE_DIR = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'forgeax-engine-assets',
  'smoke-baselines',
  'hello-sprite-atlas',
);
const REF_FILE = 'reference-dawn-walk-frame-0.png';

// --- 1. dawn.node setup --------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-sprite-atlas smoke');
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;

// AC-07 RHI statistics counters — reset before each frame, checked after each draw.
let rhiDrawIndexedCallsThisFrame = 0;
let rhiLastInstanceCount = 0;

function patchDeviceForRhiStats(dev) {
  const origCreateCommandEncoder = dev.createCommandEncoder.bind(dev);
  dev.createCommandEncoder = (desc) => {
    const enc = origCreateCommandEncoder(desc);
    const origBeginRenderPass = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (passDesc) => {
      const pass = origBeginRenderPass(passDesc);
      const origDrawIndexed = pass.drawIndexed.bind(pass);
      pass.drawIndexed = (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) => {
        rhiDrawIndexedCallsThisFrame++;
        rhiLastInstanceCount = instanceCount;
        return origDrawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
      };
      return pass;
    };
    return enc;
  };
}

const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) {
      sharedDevice = dev;
      patchDeviceForRhiStats(dev);
    }
    return dev;
  };
  return adapter;
};

// --- 2. Mock canvas ------------------------------------------------------

let activeRenderTarget = null;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (activeRenderTarget) {
          activeRenderTarget.destroy?.();
        }
        activeRenderTarget = desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {
        activeRenderTarget?.destroy?.();
        activeRenderTarget = null;
      },
      getCurrentTexture() {
        if (!activeRenderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          activeRenderTarget = sharedDevice.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
        return activeRenderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Synthetic 4-quadrant atlas texture (64x64) ----------------------
//
// Each quadrant is 32x32, filled with a distinct color so the 100
// instances render visually distinct per-frame regions. The 4 frames
// map 1:1 to the 4 quadrants (walk-0=top-left, walk-1=top-right,
// walk-2=bottom-left, walk-3=bottom-right).

function buildSyntheticAtlas() {
  const w = 64;
  const h = 64;
  const bytes = new Uint8Array(w * h * 4);
  const quadColors = [
    [220, 80, 60, 255],   // red (top-left)
    [60, 220, 90, 255],   // green (top-right)
    [60, 140, 230, 255],  // blue (bottom-left)
    [240, 200, 50, 255],  // yellow (bottom-right)
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const qi = top ? (left ? 0 : 1) : left ? 2 : 3;
      const c = quadColors[qi];
      bytes[i + 0] = c[0];
      bytes[i + 1] = c[1];
      bytes[i + 2] = c[2];
      bytes[i + 3] = c[3];
    }
  }
  return { width: w, height: h, data: bytes };
}

// Frame regions: [uMin, vMin, uW, vH] normalized [0,1].
const FRAME_REGIONS = [
  [0.0, 0.0, 0.5, 0.5],
  [0.5, 0.0, 0.5, 0.5],
  [0.0, 0.5, 0.5, 0.5],
  [0.5, 0.5, 0.5, 0.5],
];

// --- 4. Drive engine ECS path --------------------------------------------

const { ok: okResult, World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  HANDLE_QUAD,
  Instances,
  MeshFilter,
  MeshRenderer,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
  spriteAnimationTickSystem,
  Transform,
} = enginePkg;

const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[sprite-atlas] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// Register the synthetic atlas texture.
const synth = buildSyntheticAtlas();
const synthPod = {
  kind: 'texture',
  width: synth.width,
  height: synth.height,
  format: 'rgba8unorm-srgb',
  data: synth.data,
  colorSpace: 'srgb',
  mipmap: false,
};
// w64: World holds the SharedRefStore minted handles need; create it here.
const world = new World();
const textureHandle = world.allocSharedRef('TextureAsset', synthPod);

// feat-20260601-gpu-resource-store-extraction M1: texture GPU upload moved to
// renderer.store (pass POD + decoded; D-2). configureGpuDevice ran inside
// createRenderer before the renderer was returned, so the device is wired here.
const uploadRes = await renderer.store.uploadTexture(textureHandle, synthPod, {
  bytes: synth.data,
  width: synth.width,
  height: synth.height,
  mime: 'image/png',
  colorSpace: 'srgb',
  mipmap: false,
});
if (!uploadRes.ok) {
  console.error(`[smoke] FAIL - atlas texture upload: ${uploadRes.error.code}`);
  process.exit(1);
}

const samplerHandle = world.allocSharedRef('SamplerAsset', {
  kind: 'sampler',
  magFilter: 'nearest',
  minFilter: 'nearest',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
});

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// Register 4 SpriteMaterialAsset handles (one per frame region).
// Must be after renderer.ready — material shaders are registered during
// buildReadyWebGPU from manifest (no more placeholder pre-registration).
const materialHandles = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  const region = FRAME_REGIONS[i];
  materialHandles.push(
    world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        { name: 'Forward', shader: 'forgeax::sprite', tags: { LightMode: 'Forward' }, queue: 3000 },
      ],
      paramValues: {
        baseColor: [1, 1, 1, 1],
        texture: textureHandle,
        sampler: samplerHandle,
        region,
        pivot: [0.5, 0.5],
      },
    }),
  );
}

// Flat regions array for SpriteAnimation.
const flatRegions = new Float32Array(FRAME_COUNT * 4);
for (let i = 0; i < FRAME_COUNT; i++) {
  const r = FRAME_REGIONS[i];
  flatRegions[i * 4 + 0] = r[0];
  flatRegions[i * 4 + 1] = r[1];
  flatRegions[i * 4 + 2] = r[2];
  flatRegions[i * 4 + 3] = r[3];
}

// 10x10 grid instance transforms.
const instanceTransforms = new Float32Array(INSTANCE_COUNT * 16);
const GRID = 10;
const SPACING = 0.22;
for (let i = 0; i < INSTANCE_COUNT; i++) {
  const row = Math.floor(i / GRID);
  const col = i % GRID;
  const cx = (col - (GRID - 1) / 2) * SPACING;
  const cy = (row - (GRID - 1) / 2) * SPACING;
  const base = i * 16;
  instanceTransforms[base + 0] = 1;
  instanceTransforms[base + 1] = 0;
  instanceTransforms[base + 2] = 0;
  instanceTransforms[base + 3] = 0;
  instanceTransforms[base + 4] = 0;
  instanceTransforms[base + 5] = 1;
  instanceTransforms[base + 6] = 0;
  instanceTransforms[base + 7] = 0;
  instanceTransforms[base + 8] = 0;
  instanceTransforms[base + 9] = 0;
  instanceTransforms[base + 10] = 1;
  instanceTransforms[base + 11] = 0;
  instanceTransforms[base + 12] = cx;
  instanceTransforms[base + 13] = cy;
  instanceTransforms[base + 14] = 0;
  instanceTransforms[base + 15] = 1;
}

// Ortho camera
okResult(
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: 5,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: WIDTH / HEIGHT,
        near: 0.1,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -1, right: 1,
        bottom: -1, top: 1,
        clearR: CLEAR_RGBA[0],
        clearG: CLEAR_RGBA[1],
        clearB: CLEAR_RGBA[2],
        clearA: CLEAR_RGBA[3],
      },
    },
  ),
);

// Host entity: 100 instances + atlas animation.
okResult(
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [materialHandles[0]] } },
    { component: Instances, data: { transforms: instanceTransforms } },
    {
      component: SpriteAnimation,
      data: {
        frameCount: FRAME_COUNT,
        frameDuration: FRAME_DURATION,
        currentFrame: 0,
        accumDt: 0,
        regions: flatRegions,
        playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
      },
    },
    {
      component: SpriteRegionOverride,
      data: { region: new Float32Array([0, 0, 0.5, 0.5]) },
    },
  ),
);

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));

let drawCallCount = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  // Reset per-frame RHI stats before each draw (AC-07).
  rhiDrawIndexedCallsThisFrame = 0;
  rhiLastInstanceCount = 0;

  // Tick the animation system before each draw
  const tickRes = spriteAnimationTickSystem(world);
  if (!tickRes.ok) {
    console.warn(`[smoke] tick frame ${i}: ${tickRes.error.code} ${tickRes.error.hint}`);
  }

  const r = renderer.draw(world);
  if (!r.ok) {
    console.warn(`[smoke] draw frame ${i}: ${r.error.code}`);
    continue;
  }

  // AC-07: assert drawIndexed=1 per frame (1 atlas + 100 instances = 1 draw call).
  if (rhiDrawIndexedCallsThisFrame !== 1) {
    console.error(
      `[smoke] FAIL - frame ${i} drawIndexed count = ${rhiDrawIndexedCallsThisFrame}, expected 1`,
    );
    sharedDevice?.destroy?.();
    process.exit(1);
  }
  // AC-07: assert instanceCount=100 (Instances component with 10x10 grid).
  if (rhiLastInstanceCount !== INSTANCE_COUNT) {
    console.error(
      `[smoke] FAIL - frame ${i} instanceCount = ${rhiLastInstanceCount}, expected ${INSTANCE_COUNT}`,
    );
    sharedDevice?.destroy?.();
    process.exit(1);
  }

  drawCallCount++;
}

console.log(`[smoke] drawCallCount=${drawCallCount} (drawIndexed=1/frame instanceCount=${INSTANCE_COUNT} verified)`);

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames=${drawCallCount}`);

if (!activeRenderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}

// Pixel readback (BGRA -> RGBA flip, row-pad strip; identical recipe
// to apps/hello/sprite/scripts/smoke-dawn.mjs).
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: activeRenderTarget },
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
  readbackBuffer.destroy();
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const raw = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const dst = (y * WIDTH + x) * 4;
    tightRgba[dst + 0] = raw[off + 0] ?? 0;
    tightRgba[dst + 1] = raw[off + 1] ?? 0;
    tightRgba[dst + 2] = raw[off + 2] ?? 0;
    tightRgba[dst + 3] = raw[off + 3] ?? 0;
  }
}

// Reference PNG compare — exit 1 if baseline is missing (AC-07 requires committed baseline).
// To generate: run smoke on a WebGPU-capable host; the script writes the PNG and exits 1;
// inspect it then force-add (gitignore bypass) and commit before merging.
const refPath = resolve(BASELINE_DIR, REF_FILE);
if (!existsSync(refPath)) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const png = writeReferencePng(tightRgba, WIDTH, HEIGHT);
  writeFileSync(refPath, png);
  console.error(
    `[smoke] AC-07 reference PNG WRITTEN to ${refPath}. ` +
      'Inspect the file (git add -f), commit it, then rerun smoke to enter COMPARED mode.',
  );
  sharedDevice?.destroy?.();
  process.exit(1);
}

const ref = readReferencePng(refPath);
if (ref.width !== WIDTH || ref.height !== HEIGHT) {
  console.error(
    `[smoke] FAIL - reference PNG size mismatch ${ref.width}x${ref.height} != ${WIDTH}x${HEIGHT}`,
  );
  sharedDevice?.destroy?.();
  process.exit(1);
}
let maxDelta = 0;
let exceedCount = 0;
for (let i = 0; i < ref.pixels.length; i += 4) {
  const dr = Math.abs((ref.pixels[i] ?? 0) - (tightRgba[i] ?? 0)) / 255;
  const dg = Math.abs((ref.pixels[i + 1] ?? 0) - (tightRgba[i + 1] ?? 0)) / 255;
  const db = Math.abs((ref.pixels[i + 2] ?? 0) - (tightRgba[i + 2] ?? 0)) / 255;
  const d = Math.max(dr, dg, db);
  if (d > maxDelta) maxDelta = d;
  if (d > SMOKE_PIXEL_THRESHOLD) exceedCount++;
}
console.log(`[smoke] maxDelta=${maxDelta.toFixed(4)} exceed=${exceedCount}`);
if (exceedCount > Math.floor(WIDTH * HEIGHT * 0.001)) {
  console.error(
    `[smoke] FAIL - reference PNG drift ${exceedCount} px > eps=${SMOKE_PIXEL_THRESHOLD} (max=${maxDelta.toFixed(4)})`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-sprite-atlas smoke');
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 1 case GREEN: ${INSTANCE_COUNT} instances / 1 atlas / ${drawCallCount} draw calls, ` +
    `drawIndexed=1/frame instanceCount=${INSTANCE_COUNT} verified, eps=${SMOKE_PIXEL_THRESHOLD}`,
);

sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);

// ─── PNG helpers: imported from apps/shared/png-codec.mjs ───────────────