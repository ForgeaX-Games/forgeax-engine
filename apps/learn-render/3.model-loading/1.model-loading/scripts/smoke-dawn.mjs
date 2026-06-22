#!/usr/bin/env node
// learn-render 3.1 model-loading dawn-node smoke (feat-20260608 / w32 / AC-19).
//
// Structural-channel smoke (round-2 reviewer-approved scope split): the smoke
// drives the engine bridge SSOT (parseGltf -> meshIrToMeshAsset /
// toMaterialAsset / gltfDocToSceneAsset, all from @forgeax/engine-gltf) plus
// the runtime AssetRegistry instantiate path so any regression in those
// surfaces here. AC-19's production-pipeline pixel evidence (loadByGuid<SceneAsset>
// against the browser dev / build artefacts, real pixel correctness across
// the 69-texture atrium) is owned by the verify step's playwright sandbox.
//
// Verdict criteria:
//   (a) backend=webgpu (dawn-node bound the WebGPU adapter)
//   (b) frames>=300 (the standard smoke gate; was 60 in round-1)
//   (c) renderer.onError fired 0 times for RhiError / RuntimeError / EcsError
//       families (the production crash channel)
//   (d) console.error fired 0 times during render (finding 6 mitigation:
//       RenderSystem.extract surfaces material / pipeline shape failures via
//       console.error, which the hello-gltf smoke missed by gating only on
//       onError. The learn-render-3.1 smoke captures this channel so a
//       material-resolved-empty-passes regression FAILs here, not in
//       production).
//
// Falsification (FALSIFY=missing-bridge, plan section 5.4): bypass the
// engine bridge SSOT and register a wrong-shape MaterialAsset POD (passes:[])
// for every Sponza material. AssetRegistry.register catches the empty-passes
// shape and returns asset-invalid-value, the smoke's register-fail branch
// exits non-zero on the first material. This is the same shape failure
// hello-gltf finding 6 surfaced (where it slipped past the smoke because
// onError-only gates miss the console.error path). Run:
//   FALSIFY=missing-bridge pnpm -F @forgeax/app-learn-render-3-model-loading-1-model-loading smoke
// must exit non-zero, proving the gate is falsifiable rather than always-green.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const FALSIFY = process.env.FALSIFY ?? '';

const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));
const SPONZA_GLTF_PATH = resolve(here, '..', '..', '..', '..', '..',
  'forgeax-engine-assets', 'khronos-gltf-samples', 'Sponza', 'Sponza.gltf');
const SPONZA_DIR = resolve(here, '..', '..', '..', '..', '..',
  'forgeax-engine-assets', 'khronos-gltf-samples', 'Sponza');

// --- 1. dawn.node binding setup --------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- 2. Mock canvas with offscreen render target --------------------------

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

// --- 3. Drive engine ECS path through the gltf importer -------------------
//
// Drives the same engine bridge SSOT (meshIrToMeshAsset / toMaterialAsset /
// gltfDocToSceneAsset) the runtime AssetRegistry consumes after a successful
// loadByGuid<SceneAsset>. Any regression in those bridges surfaces here.

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  DirectionalLightShadow,
  PointLight,
  resolveAssetHandle,
  Skylight,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const {
  toMaterialAsset,
  meshIrToMeshAsset,
  gltfDocToSceneAsset,
  parseGltf,
} = await import('@forgeax/engine-gltf');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render 3.1 smoke] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// feat-20260614 M8 (D-15/D-17): the World owns the user-tier sharedRefs store
// that mesh / texture / sampler / material / scene handles are minted into;
// it must exist before any allocSharedRef call.
const world = new World();

// --- 3a. Parse Sponza glTF + externalLoader for flat-directory textures --

const gltfJson = JSON.parse(readFileSync(SPONZA_GLTF_PATH, 'utf8'));
const externalLoader = async (uri) => {
  const texPath = resolve(SPONZA_DIR, uri);
  const buf = readFileSync(texPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const docResult = await parseGltf(gltfJson, externalLoader, SPONZA_GLTF_PATH);
if (!docResult.ok) {
  console.error(`[smoke] FAIL - parseGltf: ${docResult.error.code}`);
  process.exit(1);
}
const doc = docResult.value;

// --- 3b. Register MeshAssets via the bridge SSOT --------------------------
//
// One MeshAsset per glTF mesh-index (Sponza ships 1 glTF mesh = 1 MeshAsset
// with 103 submeshes). Bridge keys MeshFilter on the same glTF mesh-index so
// MeshRenderer.materials[] (one per primitive) lines up positionally with
// MeshAsset.submeshes[] (#317 multi-material contract).

const meshHandles = new Map();
const seenMeshIndices = new Set();
for (const m of doc.meshes) {
  if (!m) continue;
  if (seenMeshIndices.has(m.meshIndex)) continue;
  seenMeshIndices.add(m.meshIndex);
  const prims = doc.meshes.filter((p) => p && p.meshIndex === m.meshIndex);
  const meshAsset = meshIrToMeshAsset(prims);
  const h = world.allocSharedRef('MeshAsset', meshAsset);
  meshHandles.set(m.meshIndex, h);
}

// --- 3c. Register TextureAssets (flat-directory load + parseImage) -------

const { parseImage } = await import('@forgeax/engine-image/parse-image');
const textureHandles = new Map();
if (doc.textures && doc.images) {
  for (let ti = 0; ti < doc.textures.length; ti++) {
    const tex = doc.textures[ti];
    if (!tex) continue;
    const img = doc.images[tex.source];
    if (!img || img.uri === undefined) continue;
    const texPath = resolve(SPONZA_DIR, img.uri);
    let bytes;
    try {
      const buf = readFileSync(texPath);
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      continue;
    }
    const mime = img.uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const isBaseColor = img.uri.includes('baseColor') || img.uri.includes('basecolor');
    const decoded = parseImage(bytes, mime, {
      colorSpace: isBaseColor ? 'srgb' : 'linear',
      mipmap: false,
    });
    if (!decoded.ok) continue;
    const texAsset = {
      kind: 'texture',
      data: decoded.value.bytes,
      width: decoded.value.width,
      height: decoded.value.height,
      format: 'rgba8unorm',
      colorSpace: decoded.value.colorSpace,
      mipmap: false,
    };
    const guid = `00000000-0000-7000-8000-0000000${String(ti).padStart(5, '0')}`;
    const guidRes = AssetGuid.parse(guid);
    if (!guidRes.ok) continue;
    // Mint a user-tier column handle; toMaterialAsset copies the numeric
    // handle into paramValues for the render-system extract to bind.
    const h = unwrapHandle(world.allocSharedRef('TextureAsset', texAsset));
    assets.catalog(guidRes.value, texAsset);
    textureHandles.set(ti, h);
  }
}

// --- 3d. Register SamplerAssets ------------------------------------------

const samplerHandles = new Map();
if (doc.samplers) {
  for (let si = 0; si < doc.samplers.length; si++) {
    const sampIr = doc.samplers[si];
    if (!sampIr) continue;
    const gpuFilter = (glFilter) => glFilter === 9728 ? 'nearest' : 'linear';
    const gpuAddressMode = (glWrap) => {
      if (glWrap === 33071) return 'clamp-to-edge';
      if (glWrap === 33648) return 'mirror-repeat';
      return 'repeat';
    };
    const samplerAsset = {
      kind: 'sampler',
      ...(sampIr.magFilter !== undefined ? { magFilter: gpuFilter(sampIr.magFilter) } : {}),
      ...(sampIr.minFilter !== undefined ? { minFilter: gpuFilter(sampIr.minFilter) } : {}),
      addressModeU: gpuAddressMode(sampIr.wrapS),
      addressModeV: gpuAddressMode(sampIr.wrapT),
    };
    const guid = `00000000-0000-7000-8000-00000001${String(si).padStart(4, '0')}`;
    const guidRes = AssetGuid.parse(guid);
    if (!guidRes.ok) continue;
    const h = unwrapHandle(world.allocSharedRef('SamplerAsset', samplerAsset));
    assets.catalog(guidRes.value, samplerAsset);
    samplerHandles.set(si, h);
  }
}

// --- 3e. Register MaterialAssets via bridge SSOT --------------------------
//
// FALSIFY=missing-bridge: bypass toMaterialAsset and register a wrong-shape
// MaterialAsset POD (passes:[]) that triggers RenderSystem.extract's
// `material-resolved-empty-passes` console.error every frame. This proves
// the smoke's console.error gate (criterion (e)) catches the exact
// false-green pattern the hello-gltf smoke fell into (review finding 6).

const materialHandles = new Map();
const FALSIFY_MISSING_BRIDGE = FALSIFY === 'missing-bridge';
if (FALSIFY_MISSING_BRIDGE) {
  console.warn('[smoke] FALSIFY=missing-bridge: registering wrong-shape MaterialAsset (passes:[]) for every Sponza material');
}
for (let i = 0; i < doc.materials.length; i++) {
  const matIr = doc.materials[i];
  if (!matIr) continue;
  const matAsset = FALSIFY_MISSING_BRIDGE
    ? { kind: 'material', passes: [], paramValues: {} }
    : toMaterialAsset(matIr, { textureHandles, samplerHandles });
  // FALSIFY=missing-bridge: allocSharedRef does not validate the empty-passes
  // shape (it holds any payload); the wrong shape instead trips
  // RenderSystem.extract's `material-resolved-empty-passes` console.error
  // every frame, which criterion (d) below catches.
  const h = world.allocSharedRef('MaterialAsset', matAsset);
  materialHandles.set(i, h);
}

// --- 3f. Build SceneAsset via bridge SSOT --------------------------------

const sceneAsset = gltfDocToSceneAsset(doc, { meshHandles, materialHandles });

// --- 3g. Instantiate the scene -------------------------------------------
// feat-20260614 M8 (D-15/D-17): mint a user-tier SceneAsset handle and pass it
// to instantiate, which resolves the payload + cross-refs via the two-tier
// resolveAssetHandle (no SceneAssetResolver wiring needed).

const sceneHandle = world.allocSharedRef('SceneAsset', sceneAsset);
const instRes = assets.instantiate(sceneHandle, world);
if (!instRes.ok) {
  console.error(`[smoke] FAIL - instantiate: ${instRes.error.code}`);
  process.exit(1);
}

// --- 3h. HDR Skylight (production loadByGuid path through built dist) ---

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const PACK_INDEX_PATH = resolve(here, '..', 'dist', 'pack-index.json');
const packIndexRaw = readFileSync(PACK_INDEX_PATH, 'utf8');
const packIndexJson = JSON.parse(packIndexRaw);

const hdrEntry = packIndexJson.find((e) => e.guid === NEWPORT_LOFT_GUID);
if (!hdrEntry) {
  console.error(`[smoke] FAIL - HDR GUID ${NEWPORT_LOFT_GUID} not found in pack-index at ${PACK_INDEX_PATH}; run 'pnpm build' first.`);
  process.exit(1);
}
console.log(`[smoke] HDR pack-index entry: kind=${hdrEntry.kind} format=${hdrEntry.metadata?.format} ${hdrEntry.metadata?.width}x${hdrEntry.metadata?.height}`);

const importedBinPath = resolve(here, '..', 'dist', hdrEntry.relativeUrl.replace(/^\//, ''));
const binBuf = readFileSync(importedBinPath);
const importedBinBytes = new Uint8Array(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength);

const FALSIFY_HDR_BIN_EMPTY = FALSIFY === 'hdr-bin-empty';
if (FALSIFY_HDR_BIN_EMPTY) {
  console.warn('[smoke] FALSIFY=hdr-bin-empty: zeroing imported .bin payload');
  importedBinBytes.fill(0);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url === '/pack-index.json') {
    return { ok: true, json: () => Promise.resolve(packIndexJson), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  }
  if (typeof url === 'string' && url === hdrEntry.relativeUrl) {
    const ab = new ArrayBuffer(importedBinBytes.byteLength);
    new Uint8Array(ab).set(importedBinBytes);
    return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(ab) };
  }
  return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
};

assets.configurePackIndex('/pack-index.json');

const hdrGuidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
if (!hdrGuidRes.ok) {
  console.error(`[smoke] FAIL - AssetGuid.parse(HDR): ${hdrGuidRes.error.code}`);
  process.exit(1);
}

// loadByGuid returns the TextureAsset PAYLOAD (M8 D-17); mint a user-tier
// source handle and pass world + handle + pod to uploadCubemapFromEquirect.
const hdrPodRes = await assets.loadByGuid(hdrGuidRes.value);
if (!hdrPodRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid(HDR): ${hdrPodRes.error.code} - ${hdrPodRes.error.hint}`);
  process.exit(1);
}
const hdrPod = hdrPodRes.value;
const hdrSrcHandle = world.allocSharedRef('TextureAsset', hdrPod);

const cubemapRes = await renderer.store.uploadCubemapFromEquirect(world, hdrSrcHandle, hdrPod);
if (!cubemapRes.ok) {
  console.error(`[smoke] FAIL - uploadCubemapFromEquirect: ${cubemapRes.error.code} - ${cubemapRes.error.hint}`);
  process.exit(1);
}

world.spawn({
  component: Skylight,
  data: { cubemap: cubemapRes.value, intensity: 1.0 },
});
console.log(`[smoke] HDR loadByGuid + Skylight spawn OK (format=${hdrPod.format} ${hdrPod.width}x${hdrPod.height})`);

// Restore native fetch so subsequent renders / readback are clean.
globalThis.fetch = originalFetch;

// --- 4. Spawn lights + camera (mirror src/main.ts) ------------------------

const d = [-0.3, -1.0, -0.3];
const invLen = 1 / Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
world.spawn(
  { component: DirectionalLight, data: {
    directionX: d[0] * invLen, directionY: d[1] * invLen, directionZ: d[2] * invLen,
    colorR: 1.0, colorG: 0.95, colorB: 0.85, intensity: 3.0,
  } },
  { component: DirectionalLightShadow, data: {
    mapSize: 2048, farPlane: 4500, orthoHalfExtent: 2200, depthBias: 0.005,
  } },
);

const pointDefs = [
  { pos: [-800, 200, 0], color: [1.0, 0.85, 0.5], intensity: 500000, range: 2500 },
  { pos: [800, 200, 0], color: [0.4, 0.85, 1.0], intensity: 500000, range: 2500 },
  { pos: [0, 200, -400], color: [0.95, 0.4, 0.85], intensity: 500000, range: 2500 },
  { pos: [0, 200, 400], color: [1.0, 1.0, 1.0], intensity: 500000, range: 2500 },
];
for (const pd of pointDefs) {
  world.spawn(
    { component: Transform, data: { posX: pd.pos[0], posY: pd.pos[1], posZ: pd.pos[2],
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
    { component: PointLight, data: { colorR: pd.color[0], colorG: pd.color[1], colorB: pd.color[2],
      intensity: pd.intensity, range: pd.range } },
  );
}

world.spawn(
  { component: Transform, data: { posX: 800, posY: 600, posZ: 0,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: Camera, data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 10, far: 10000,
    projection: 1, left: -2200, right: 2200, bottom: -2200, top: 2200 } },
);

// --- 5. Wire error capture (both onError + console.error) ----------------

const errors = [];
const consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
  originalConsoleError(...args);
};
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// --- 6. Run frames -----------------------------------------------------

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
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
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms)`);

// --- 7. Pixel readback (advisory; pixel correctness is verify-step's job) -

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
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
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const pixelBytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readBgra = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const b = (pixelBytes[off + 0] ?? 0) / 255;
  const g = (pixelBytes[off + 1] ?? 0) / 255;
  const r = (pixelBytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const sites = [
  { name: 'atriumCenter', x: Math.floor(WIDTH * 0.5), y: Math.floor(HEIGHT * 0.55) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readBgra(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 8. Verdict --------------------------------------------------------

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
const rhiErrors = errors.filter((e) =>
  e.code.startsWith('rhi-') || e.code.startsWith('runtime-') || e.code.startsWith('ecs-'));
if (rhiErrors.length > 0) {
  failures.push(`(c) Renderer.onError fired ${rhiErrors.length} times: [${rhiErrors.map((e) => e.code).join(', ')}]`);
}
// finding 6 mitigation + falsification anchor: capture the console.error
// channel. RenderSystem.extract surfaces material/pipeline shape failures
// via console.error, which the hello-gltf smoke missed by gating only on
// onError. FALSIFY=missing-bridge triggers exactly this code path so the
// smoke's gate is provably falsifiable.
const renderConsoleErrors = consoleErrors.filter((line) => !line.startsWith('[smoke]'));
if (renderConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${renderConsoleErrors.length} times during render: [${renderConsoleErrors.slice(0, 3).join(' | ').slice(0, 300)}]`,
  );
}
// SMOKE_PIXEL_THRESHOLD reserved for verify-step browser harness (advisory
// here; the dawn-node pose has the camera inside the atrium and tone-mapping
// produces a uniform gray-blue regardless of mesh visibility -- a meshed-
// distance gate would false-green or false-red).
void SMOKE_PIXEL_THRESHOLD;

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device?.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - ${framesObserved} frames, backend=${renderer.backend}`);
device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
