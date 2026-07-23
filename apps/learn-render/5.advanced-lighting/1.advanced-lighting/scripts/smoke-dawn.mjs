#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/1.advanced-lighting/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 1.advanced-lighting dawn-node smoke.
// >=60 frames, onError=0, AND pixel readback (the floor must be lit, not just
// ambient). The pixel check exists because the structural-only predecessor
// stayed green while the demo rendered an all-black frame: a custom material
// shader lit a cube from a light placed at the cube's own center, so every
// visible face was back-lit and only the 0.05*tex ambient term survived.
//
// IMPORTANT: the custom material shader compiles its PSO asynchronously
// (getMaterialShaderPipeline returns 'rhi-not-available' until the device
// finishes the compile). A purely synchronous draw loop never lets that
// resolve, so this harness awaits queue.onSubmittedWorkDone() between frames
// to give the compile a chance to land before readback.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-1-blinn-phong] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' smoke",
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

// --- 3. Asset fixtures check ---

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const { createPlaneGeometry } = await import('@forgeax/engine-geometry');
const { Camera, createRenderer, MeshFilter, MeshRenderer, Transform } = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    woodDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-5-1-blinn-phong] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

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

console.log(`[learn-render-5-1-blinn-phong] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// Register the custom Blinn-Phong shader.
const shader = renderer.shader;
if (shader === null) {
  console.error('[smoke] FAIL - renderer.shader is null');
  process.exit(1);
}

// Register the custom Blinn-Phong shader from the build-output COMPOSED WGSL.
// `ShaderRegistry.registerMaterialShader` requires post-naga_oil composed WGSL
// (see packages/shader/src/ShaderRegistry.ts: `source` = "composed WGSL source
// (post-naga_oil)"). The runtime deliberately does NOT bundle naga_oil, so the
// raw `src/blinn-phong.wgsl` (which opens with `#define_import_path` + `#import`)
// cannot be registered directly -- it must go through the build-time vite-plugin
// composition (exactly as the real app does via `import ... from './blinn-phong.wgsl'`).
// This smoke has no vite transform, so read the demo build's composed entry from
// dist/shaders/manifest.json (mirrors apps/hello/custom-shader/scripts/smoke-dawn.mjs).
const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  console.error(
    "  hint: rebuild via `pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' build`",
  );
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const blinnPhongEntry = (demoManifest.materialShaders ?? []).find(
  (m) => m && m.identifier === 'learn-render::5-1-blinn-phong',
);
if (!blinnPhongEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing 5_1_blinn_phong entry');
  process.exit(1);
}
shader.registerMaterialShader('learn-render::5-1-blinn-phong', {
  source: blinnPhongEntry.composedWgsl,
  paramSchema: JSON.parse(blinnPhongEntry.paramSchema),
});

// Register texture under its GUID (wood.png, the LO 5.1 floor texture).
const woodGuidRes = AssetGuid.parse('019e3969-1d48-7c3b-ac24-6d68f457065f');
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const woodTexAsset = {
  kind: 'texture',
  width: woodDecoded.width,
  height: woodDecoded.height,
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mipmap: woodDecoded.mipmap,
};

const world = new World();

// Catalogue the texture under its GUID, then mint a shared-ref column handle.
assets.catalog(woodGuidRes.value, woodTexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);
console.log(`[learn-render-5-1-blinn-phong] registered wood handle id=${woodHandle}`);

// Register material with the custom shader.
const matHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'learn-render::5-1-blinn-phong',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColorTexture: unwrapHandle(woodHandle),
  },
});

// Floor plane: 20x20 on XZ at y=-0.5, normal +Y facing the overhead light
// at the origin (LIGHT_POS in blinn-phong.wgsl). The procedural plane faces
// +Z, so rotate -90deg about X (quat = (sin(-pi/4),0,0,cos(-pi/4))).
const floorRes = createPlaneGeometry(20, 20);
if (!floorRes.ok) {
  console.error('[smoke] FAIL - createPlaneGeometry failed:', floorRes.error.code);
  process.exit(1);
}
const floorHandle = world.allocSharedRef('MeshAsset', floorRes.value);
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, -0.5, 0], quat: [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: floorHandle } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  )
  .unwrap();

// Camera at (0, 0, 3), FOV=45 deg.
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

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  // Await each frame's GPU work so the custom material shader's async PSO
  // compile resolves (a synchronous loop leaves it perpetually
  // 'rhi-not-available' -> skip-draw -> black; see file header).
  await device.queue.onSubmittedWorkDone();
}
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 6. Pixel readback ---
//
// The floor must be LIT, not just ambient. A back-lit surface (light behind
// every visible face, the cube-at-origin regression) caps at 0.05*tex ~=
// 10/255; a diffuse-lit wood floor peaks ~100+/255. Threshold 40/255 sits
// between the two so it falsifies the regression without compositor jitter.
const SMOKE_LIT_LUMA = Number.parseInt(process.env.SMOKE_LIT_LUMA ?? '40', 10);

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
const pixelBytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

let maxLuma = 0;
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const l = Math.max(pixelBytes[off] ?? 0, pixelBytes[off + 1] ?? 0, pixelBytes[off + 2] ?? 0);
    if (l > maxLuma) maxLuma = l;
  }
}
console.log(`[smoke] maxLuma=${maxLuma} (threshold=${SMOKE_LIT_LUMA})`);

// --- 7. Verdict ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
if (maxLuma <= SMOKE_LIT_LUMA)
  failures.push(
    `(d) maxLuma=${maxLuma} <= ${SMOKE_LIT_LUMA} — surface unlit (only ambient survives; light back-facing all visible geometry)`,
  );

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, maxLuma=${maxLuma}, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
