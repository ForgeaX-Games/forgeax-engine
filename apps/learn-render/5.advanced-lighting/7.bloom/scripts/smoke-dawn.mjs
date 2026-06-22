#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/7.bloom/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.7 - Bloom dawn-node smoke.
// Structural-only: >=60 frames, onError=0, perFramePassNames includes
// 4 bloom passes + tonemap. Camera.bloom readback asserts spawn wiring.
// No pixel readback (bloom visual verdict is verify-step territory).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-7-bloom] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');
const CONTAINER2_SRC_PATH = resolve(TEXTURES_DIR, 'container2.png');
const CONTAINER2_SPECULAR_SRC_PATH = resolve(TEXTURES_DIR, 'container2_specular.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';
const CONTAINER2_SPECULAR_GUID_STR = '019e3969-1d46-76ca-9a46-2168b746a292';

// Bloom pass names expected in the URP default 9-pass chain when bloom is enabled.
const BLOOM_PASS_NAMES = ['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite'];
const TONEMAP_PASS_NAME = 'tonemap';

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-7-bloom' smoke",
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

if (!existsSync(WOOD_SRC_PATH) || !existsSync(CONTAINER2_SRC_PATH) || !existsSync(CONTAINER2_SPECULAR_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${WOOD_SRC_PATH}, ${CONTAINER2_SRC_PATH}, or ${CONTAINER2_SPECULAR_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode textures + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  BLOOM_ENABLED,
  Camera,
  createRenderer,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  PointLight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
const container2DecodeRes = await decodeImageFromFile(CONTAINER2_SRC_PATH);
const container2SpecularDecodeRes = await decodeImageFromFile(CONTAINER2_SPECULAR_SRC_PATH);
if (!woodDecodeRes.ok || !container2DecodeRes.ok || !container2SpecularDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    woodDecodeRes.ok ? null : woodDecodeRes.error.code,
    container2DecodeRes.ok ? null : container2DecodeRes.error.code,
    container2SpecularDecodeRes.ok ? null : container2SpecularDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
const { decoded: container2Decoded } = container2DecodeRes.value;
const { decoded: container2SpecularDecoded } = container2SpecularDecodeRes.value;
console.log(
  `[learn-render-7-bloom] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);
console.log(
  `[learn-render-7-bloom] decoded container2=${container2Decoded.width}x${container2Decoded.height} ${container2Decoded.mime}`,
);
console.log(
  `[learn-render-7-bloom] decoded container2_specular=${container2SpecularDecoded.width}x${container2SpecularDecoded.height} ${container2SpecularDecoded.mime}`,
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

console.log(`[learn-render-7-bloom] backend=${renderer.backend}`);

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

// Register textures under their GUIDs.
const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
const container2SpecularGuidRes = AssetGuid.parse(CONTAINER2_SPECULAR_GUID_STR);
if (!woodGuidRes.ok || !container2GuidRes.ok || !container2SpecularGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

function makeTexAsset(decoded) {
  return {
    kind: 'texture',
    width: decoded.width,
    height: decoded.height,
    format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    data: decoded.bytes,
    colorSpace: decoded.colorSpace,
    mipmap: decoded.mipmap,
  };
}

const world = new World();

// Catalogue the textures under their GUIDs, then mint shared-ref column handles.
const woodTexAsset = makeTexAsset(woodDecoded);
const container2TexAsset = makeTexAsset(container2Decoded);
const container2SpecularTexAsset = makeTexAsset(container2SpecularDecoded);
assets.catalog(woodGuidRes.value, woodTexAsset);
assets.catalog(container2GuidRes.value, container2TexAsset);
assets.catalog(container2SpecularGuidRes.value, container2SpecularTexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);
const container2Handle = world.allocSharedRef('TextureAsset', container2TexAsset);
const container2SpecularHandle = world.allocSharedRef('TextureAsset', container2SpecularTexAsset);
console.log(`[learn-render-7-bloom] registered wood handle id=${woodHandle}`);
console.log(`[learn-render-7-bloom] registered container2 handle id=${container2Handle}`);
console.log(`[learn-render-7-bloom] registered container2Specular handle id=${container2SpecularHandle}`);

// Register materials: wood floor + 3 emissive light boxes.
const floorMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.9,
    baseColorTexture: unwrapHandle(woodHandle),
  },
});

function makeBoxMaterial(intensity) {
  return world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.8,
      roughness: 0.3,
      emissive: [2.0, 1.8, 1.5],
      emissiveIntensity: intensity,
      emissiveTexture: unwrapHandle(container2SpecularHandle),
      baseColorTexture: unwrapHandle(container2Handle),
    },
  });
}

const boxAMatHandle = makeBoxMaterial(2.0);
const boxBMatHandle = makeBoxMaterial(1.5);
const boxCMatHandle = makeBoxMaterial(0.4);

// Spawn wood floor: HANDLE_CUBE scaled flat and wide.
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: -0.5, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 10, scaleY: 0.1, scaleZ: 4,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();

// Spawn 3 emissive light boxes at (-3, 0, 3) along X.
for (const [posX, handle] of [
  [-3.0, boxAMatHandle],
  [0.0, boxBMatHandle],
  [3.0, boxCMatHandle],
]) {
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX, posY: 0.6, posZ: 0,
          quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
          scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
}

// Point light above the scene.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 3, posZ: 2,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  { component: PointLight, data: {} },
);

// Camera with bloom enabled + tonemap (URP default pipeline path).
const cameraEntity = world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 1.5, posZ: 8,
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
        tonemap: TONEMAP_REINHARD_EXTENDED,
        bloom: BLOOM_ENABLED,
        bloomThreshold: 1.0,
        bloomIntensity: 1.0,
        bloomBlurRadius: 4.0,
      },
    },
  )
  .unwrap();

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

// Read perFramePassNames before stop/destroy (research F-7 hard constraint).
const passNames = renderer.perFramePassNames;

// Read back Camera component for bloom field (assert spawn wiring).
const cameraBloomRes = world.get(cameraEntity, Camera);
const cameraBloom = cameraBloomRes.ok ? cameraBloomRes.value.bloom : undefined;

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

// --- 6. Verdict (structural-only) ---

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// Check bloom pass names are all present.
const passNameSet = new Set(passNames);
const missingBloomPasses = BLOOM_PASS_NAMES.filter((n) => !passNameSet.has(n));
if (missingBloomPasses.length > 0) {
  failures.push(
    `(d) perFramePassNames missing bloom passes: [${missingBloomPasses.join(', ')}] (got [${passNames.join(', ')}])`,
  );
}
if (!passNameSet.has(TONEMAP_PASS_NAME)) {
  failures.push(
    `(e) perFramePassNames missing tonemap pass (got [${passNames.join(', ')}])`,
  );
}

// Check Camera.bloom = BLOOM_ENABLED (spawn wiring regression guard).
if (cameraBloom !== BLOOM_ENABLED) {
  failures.push(
    `(f) Camera.bloom=${cameraBloom} (expected ${BLOOM_ENABLED} = BLOOM_ENABLED)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-7-bloom' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - ${failures.length === 0 ? 'all' : 'remaining'} criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, bloom passes present, tonemap pass present, Camera.bloom=BLOOM_ENABLED`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);