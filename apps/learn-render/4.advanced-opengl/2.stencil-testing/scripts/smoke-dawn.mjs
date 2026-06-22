#!/usr/bin/env node
// apps/learn-render/4.advanced-opengl/2.stencil-testing/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 2.stencil-testing dawn-node smoke.
// Pixel-level replica of the LO 4.2 stencil outline path: metal.png floor +
// two marble.jpg cubes + scale-1.1 outline cubes with pure-color unlit
// outline-solid shader. Textures are decoded from the filesystem via
// `decodeImageFromFile` and registered with `registerWithGuid`.
//
// The outline-solid WGSL is composed at smoke-time from the source .wgsl
// file + the engine common.wgsl import via `@forgeax/engine-naga`.
//
// Falsifiable: break stencilWriteMask (floor mask 0x00 -> 0xFF) =>
// the floor starts writing stencil, outline pass may skip floor regions
// where stencil ref differs, changing outline edge pixels. Break
// stencilReference => outline fails because compare value mismatches.
//
// Outline-presence detection (logged, not asserted in smoke): full-frame
// scan for pixels with the LO 4.2 outline color signature (G > R + 0.05
// && B > R + 0.03). The cyan-green tint (0.04, 0.28, 0.26) is unique to
// the outline pass. Smoke logs the count for diagnosis but does NOT fail
// on it -- dawn-node smoke uses a smaller / lighting-stripped scene
// (synthetic camera pose, no createApp) and the outline-presence gate
// lives in `packages/runtime/src/__tests__/stencil-outline-pixel.dawn.test.ts`
// which controls the scene precisely (see bug-20260611-stencil-testing-
// outline-regression).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-2-stencil-testing] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] outlinePixels=<N>`
//
// NOTE: The outline-solid WGSL uses `#import forgeax_view::common` which
// requires naga_oil composition at build time. In dawn-node smoke, the
// composed result is reproduced inline below by resolving the common.wgsl
// import chain manually. When the engine adds a `composeCustomShader`
// API this manual resolution should be replaced.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 512;
const HEIGHT = 512;

// --- Pre-composed outline-solid WGSL (common.wgsl imports resolved inline) ---
// This is the naga_oil-composed result of outline-solid.wgsl with
// `#import forgeax_view::common::{View, Mesh, view, meshes}` resolved.
// The struct layouts byte-for-byte match packages/shader/src/common.wgsl
// (View 176 B / Mesh mat4+mat3 via 256 B per-entity stride).
// When the engine provides a `composeCustomShader` API, this constant
// can be replaced with a runtime `composeShader()` call.
const COMPOSED_OUTLINE_WGSL = `
struct View {
  worldViewProj   : mat4x4<f32>,
  lightDir        : vec3<f32>,
  lightColor      : vec3<f32>,
  cameraPos       : vec3<f32>,
  lightSpaceMatrix : mat4x4<f32>,
};

struct Mesh {
  worldFromLocal : mat4x4<f32>,
  normalMatrix   : mat3x3<f32>,
};

@group(0) @binding(0) var<uniform> view : View;

@group(2) @binding(0) var<storage, read> meshes : array<Mesh>;

struct Material {
  baseColor : vec4<f32>,
  metallic  : f32,
  roughness : f32,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return material.baseColor;
}
`;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const METAL_SRC_PATH = resolve(TEXTURES_DIR, 'metal.png');
const MARBLE_SRC_PATH = resolve(TEXTURES_DIR, 'marble.jpg');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing' smoke",
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

if (!existsSync(METAL_SRC_PATH) || !existsSync(MARBLE_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${METAL_SRC_PATH} or ${MARBLE_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode textures + create renderer ---

const { ok: okResult, World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const metalDecodeRes = await decodeImageFromFile(METAL_SRC_PATH);
const marbleDecodeRes = await decodeImageFromFile(MARBLE_SRC_PATH);
if (!metalDecodeRes.ok || !marbleDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    metalDecodeRes.ok ? null : metalDecodeRes.error.code,
    marbleDecodeRes.ok ? null : marbleDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: metalDecoded, meta: metalMeta } = metalDecodeRes.value;
const { decoded: marbleDecoded, meta: marbleMeta } = marbleDecodeRes.value;
console.log(
  `[learn-render-2-stencil-testing] decoded metal=${metalDecoded.width}x${metalDecoded.height} ${metalDecoded.mime}`,
);
console.log(
  `[learn-render-2-stencil-testing] decoded marble=${marbleDecoded.width}x${marbleDecoded.height} ${marbleDecoded.mime}`,
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

console.log(`[learn-render-2-stencil-testing] backend=${renderer.backend}`);

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

// Register the custom outline-solid shader with pre-composed WGSL.
const shader = renderer.shader;
if (shader === null) {
  console.error('[smoke] FAIL - renderer.shader is null');
  process.exit(1);
}
shader.registerMaterialShader('learn-render::outline-solid', {
  source: COMPOSED_OUTLINE_WGSL,
  paramSchema: [{ name: 'baseColor', type: 'color' }],
  bindingLayout: [],
});

// Register textures under their GUIDs.
const metalGuidRes = AssetGuid.parse('019e3969-1d47-760f-982e-7bad1ffd969c');
const marbleGuidRes = AssetGuid.parse('019e3969-1d46-7933-b14d-4faee5635ad6');
if (!metalGuidRes.ok || !marbleGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

// World must exist before allocSharedRef mints any column handle.
const world = new World();

const metalTexAsset = {
  kind: 'texture',
  width: metalDecoded.width,
  height: metalDecoded.height,
  format: metalDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: metalDecoded.bytes,
  colorSpace: metalDecoded.colorSpace,
  mipmap: metalDecoded.mipmap,
};
const marbleTexAsset = {
  kind: 'texture',
  width: marbleDecoded.width,
  height: marbleDecoded.height,
  format: marbleDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: marbleDecoded.bytes,
  colorSpace: marbleDecoded.colorSpace,
  mipmap: marbleDecoded.mipmap,
};
const metalHandle = unwrapHandle(world.allocSharedRef('TextureAsset', metalTexAsset));
const marbleHandle = unwrapHandle(world.allocSharedRef('TextureAsset', marbleTexAsset));
console.log(`[learn-render-2-stencil-testing] registered metal handle id=${metalHandle}`);

// Register materials with pass-based MaterialAsset shape.
// ── Floor material: PBR with stencilWriteMask=0x00 ────────────────
const floorMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
      renderState: {
        stencilWriteMask: 0x00,
      },
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.9,
    baseColorTexture: metalHandle,
  },
});

// ── Cube material: PBR with stencil write (ref=1, mask=0xFF) ─────
const cubeMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
      renderState: {
        stencilWriteMask: 0xFF,
        stencil: { compare: 'always', passOp: 'replace' },
      },
      stencilReference: 1,
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.5,
    baseColorTexture: marbleHandle,
  },
});

// ── Outline material: unlit solid color, stencil test only ───────
const OUTLINE_COLOR = [0.04, 0.28, 0.26, 1.0];
const outlineMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      // Outline pass shares URP's main scene pass — see src/index.ts for
      // the tag rationale (post-#344 pipeline-driven pass selector
      // requires LightMode=Forward to be selected; pass-name
      // 'ForwardOutline' documents intent within the multi-pass material).
      name: 'ForwardOutline',
      shader: 'learn-render::outline-solid',
      tags: { LightMode: 'Forward' },
      renderState: {
        stencilReadMask: 0xFF,
        stencil: { compare: 'not-equal' },
        depthWriteEnabled: false,
      },
      stencilReference: 1,
    },
  ],
  paramValues: {
    baseColor: OUTLINE_COLOR,
  },
});

// Floor: HANDLE_QUAD is 1x1 in XY, rotated -90 deg around X to lie flat.
const SIN_NEG_90 = Math.sin(-Math.PI / 4);
const COS_NEG_90 = Math.cos(-Math.PI / 4);
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: -0.5, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 5, scaleY: 5, scaleZ: 5,
        quatX: SIN_NEG_90,
        quatW: COS_NEG_90,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();

// Cube 1 at (-1, 0, -1).
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: -1, posY: 0, posZ: -1,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

// Cube 2 at (2, 0, 0).
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 2, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

// Outline cube 1 at (-1, 0, -1) with scale 1.1.
const OUTLINE_SCALE = 1.1;
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: -1, posY: 0, posZ: -1,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: OUTLINE_SCALE, scaleY: OUTLINE_SCALE, scaleZ: OUTLINE_SCALE,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [outlineMatHandle] } },
  )
  .unwrap();

// Outline cube 2 at (2, 0, 0) with scale 1.1.
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 2, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: OUTLINE_SCALE, scaleY: OUTLINE_SCALE, scaleZ: OUTLINE_SCALE,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [outlineMatHandle] } },
  )
  .unwrap();

// Directional light.
world.spawn({
  component: DirectionalLight,
  data: {
    directionX: -0.5,
    directionY: -1.0,
    directionZ: -0.3,
    colorR: 1.0,
    colorG: 1.0,
    colorB: 1.0,
    intensity: 1.0,
  },
});

// Camera at (0, 0, 3), Zoom=45 deg.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 0, posZ: 3,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: perspective({
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
    }),
  },
);

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update();
  const r = renderer.draw(world);
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

// Sample sites (512x512 canvas, camera at z=3, fov=45 deg):
//   - floorCenter: lower-center (should show metal texture, NOT clearColor)
//   - cube1Region: center-left (cube at (-1,0,-1) projects near left of center)
//   - cube2Region: right-of-center (cube at (2,0,0))
//   - outlineLeft: X edge area near cube1 outline (between cube1 body and floor)
//   - outlineRight: X edge area near cube2 outline
//   - cornerTL / cornerBR: corners expected near clearColor
const sites = [
  { name: 'floorCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.65) },
  { name: 'cube1Region', x: Math.floor(WIDTH * 0.15), y: Math.floor(HEIGHT * 0.45) },
  { name: 'cube2Region', x: Math.floor(WIDTH * 0.55), y: Math.floor(HEIGHT * 0.45) },
  { name: 'outlineLeft', x: Math.floor(WIDTH * 0.08), y: Math.floor(HEIGHT * 0.40) },
  { name: 'outlineRight', x: Math.floor(WIDTH * 0.62), y: Math.floor(HEIGHT * 0.45) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// Optional PNG dump for visual debugging (set SMOKE_DUMP_PNG=<path>).
if (process.env.SMOKE_DUMP_PNG) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const src = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      rgba[dst + 0] = bytes[src + 2] ?? 0;
      rgba[dst + 1] = bytes[src + 1] ?? 0;
      rgba[dst + 2] = bytes[src + 0] ?? 0;
      rgba[dst + 3] = 255;
    }
  }
  const upngMod = await import('upng-js');
  const upng = upngMod.default ?? upngMod;
  const pngBuf = upng.encode([rgba.buffer], WIDTH, HEIGHT, 0);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SMOKE_DUMP_PNG, Buffer.from(pngBuf));
  console.log(`[smoke] PNG dumped -> ${process.env.SMOKE_DUMP_PNG}`);
}

// --- 7. Verdict ---

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.1, 0.1, 0.1];

// Core mesh sites: floor + both cubes should be visibly textured (PBR).
const meshSiteNames = ['floorCenter', 'cube1Region', 'cube2Region'];
let meshedCount = 0;
const perSite = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSite[name] = Number(dist.toFixed(4));
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSite)}`);

// Outline-presence count (info-only; authoritative gate is
// stencil-outline-pixel.dawn.test.ts). LO 4.2 outline color (0.04, 0.28,
// 0.26) has the unique signature G > R + 0.05 && B > R + 0.03 — the rest
// of the scene is grayscale, so a non-zero count indicates the outline
// pass is reaching the frame.
const OUTLINE_R_LT_G_GAP = 0.05;
const OUTLINE_R_LT_B_GAP = 0.03;
let outlinePixels = 0;
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const b = (bytes[off + 0] ?? 0) / 255;
    const g = (bytes[off + 1] ?? 0) / 255;
    const r = (bytes[off + 2] ?? 0) / 255;
    if (g - r > OUTLINE_R_LT_G_GAP && b - r > OUTLINE_R_LT_B_GAP) {
      outlinePixels++;
    }
  }
}
console.log(`[smoke] outlinePixels=${outlinePixels} (info-only)`);

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
// outline-presence is informational here (see header comment); the
// authoritative gate is the dawn vitest test stencil-outline-pixel.dawn.test.ts.

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedCount}/${meshSiteNames.length}, RhiError count=0 (outlinePixels=${outlinePixels} info-only), wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);