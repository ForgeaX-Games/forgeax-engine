#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/4.normal-mapping/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 4.normal-mapping dawn-node smoke.
// Structural-only: >=60 frames, onError=0, no pixel readback.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-4-normal-mapping] backend=<backend>`
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
const BRICKWALL_SRC_PATH = resolve(TEXTURES_DIR, 'brickwall.jpg');
const BRICKWALL_NORMAL_SRC_PATH = resolve(TEXTURES_DIR, 'brickwall_normal.jpg');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping' smoke",
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

if (!existsSync(BRICKWALL_SRC_PATH) || !existsSync(BRICKWALL_NORMAL_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${BRICKWALL_SRC_PATH} or ${BRICKWALL_NORMAL_SRC_PATH}`,
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
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const brickwallDecodeRes = await decodeImageFromFile(BRICKWALL_SRC_PATH);
const brickwallNormalDecodeRes = await decodeImageFromFile(BRICKWALL_NORMAL_SRC_PATH);
if (!brickwallDecodeRes.ok || !brickwallNormalDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    brickwallDecodeRes.ok ? null : brickwallDecodeRes.error.code,
    brickwallNormalDecodeRes.ok ? null : brickwallNormalDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: brickwallDecoded } = brickwallDecodeRes.value;
const { decoded: brickwallNormalDecoded } = brickwallNormalDecodeRes.value;
console.log(
  `[learn-render-4-normal-mapping] decoded brickwall=${brickwallDecoded.width}x${brickwallDecoded.height} ${brickwallDecoded.mime}`,
);
console.log(
  `[learn-render-4-normal-mapping] decoded brickwall_normal=${brickwallNormalDecoded.width}x${brickwallNormalDecoded.height} ${brickwallNormalDecoded.mime}`,
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

console.log(`[learn-render-4-normal-mapping] backend=${renderer.backend}`);

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
const brickwallGuidRes = AssetGuid.parse('019e3969-1d45-78a4-9f59-a41c910656f4');
const brickwallNormalGuidRes = AssetGuid.parse('019e3969-1d46-78ef-b4d9-0163f7f93193');
if (!brickwallGuidRes.ok || !brickwallNormalGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const baseColorTexAsset = {
  kind: 'texture',
  width: brickwallDecoded.width,
  height: brickwallDecoded.height,
  format: brickwallDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: brickwallDecoded.bytes,
  colorSpace: brickwallDecoded.colorSpace,
  mipmap: brickwallDecoded.mipmap,
};
const normalTexAsset = {
  kind: 'texture',
  width: brickwallNormalDecoded.width,
  height: brickwallNormalDecoded.height,
  format: brickwallNormalDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: brickwallNormalDecoded.bytes,
  colorSpace: brickwallNormalDecoded.colorSpace,
  mipmap: brickwallNormalDecoded.mipmap,
};
const world = new World();

// Catalogue the textures under their GUIDs, then mint shared-ref column handles.
assets.catalog(brickwallGuidRes.value, baseColorTexAsset);
assets.catalog(brickwallNormalGuidRes.value, normalTexAsset);
const baseColorHandle = world.allocSharedRef('TextureAsset', baseColorTexAsset);
const normalHandle = world.allocSharedRef('TextureAsset', normalTexAsset);
console.log(`[learn-render-4-normal-mapping] registered brickwall handle id=${baseColorHandle}`);

// Register material with pass-based MaterialAsset shape.
const wallMatHandle = world.allocSharedRef('MaterialAsset', {
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
    roughness: 0.8,
    baseColorTexture: unwrapHandle(baseColorHandle),
    normalTexture: unwrapHandle(normalHandle),
  },
});

// Spawn quad: HANDLE_QUAD is 1x1 in XY, faces +Z.
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [wallMatHandle] } },
  )
  .unwrap();

// Point light at (0.5, 1, 0.3) — LO 5.4 verbatim.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0.5, posY: 1, posZ: 0.3,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  { component: PointLight, data: {} },
);

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
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update();
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

// --- 6. Verdict (structural-only) ---

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

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);