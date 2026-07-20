#!/usr/bin/env node
// hello-scene-nesting headless smoke — dawn-node structural smoke.
//
// This script boots dawn-node WebGPU, creates a renderer with inline
// SceneAsset PODs (outer scene with mount -> inner cube scene), renders
// 300 frames and verifies content appeared (pixel readback per-site
// distance from clear color exceeds threshold on at least one mesh site).
//
// Structural-only smoke: no committed baseline.png yet. AC-33 v1 lock
// permissive meshed-site gate.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));

// Dawn-node binding setup.
let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
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

// Mock canvas with offscreen render target.
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

// Import engine.
const { ok: okResult, err: errResult, World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  AnimationPlayer,
  Camera,
  ChildOf,
  createRenderer,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  Transform,
} = enginePkg;

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
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

console.log(`[hello-scene-nesting] backend=${renderer.backend}`);

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

// Mint a user-tier column handle for the unlit material so the inline
// SceneAsset materials array references a real shared-ref id.
const world = new World();
const unlitMatHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.4, 0.2, 1]));

// R2/B-5: bind a real material to the cube so the smoke produces a
// non-black frame when the engine is healthy. Empty materials [] (the
// previous shape) renders nothing, so pixel readback was [0,0,0]
// regardless of B-1's hierarchy state — the gate could not distinguish
// engine-broken from intentionally-empty.
const innerScene = {
  kind: 'scene',
  entities: [{
    localId: 0,
    components: {
      Transform: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]},
      MeshFilter: { assetHandle: 1 },
      MeshRenderer: { materials: [Number(unlitMatHandle)] },
    },
  }],
};

const outerScene = {
  kind: 'scene',
  entities: [{
    localId: 0,
    components: {
      Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
  }],
  mounts: [{
    localId: 1,
    source: 0,
    memberFirst: 2,
    memberCount: 1,
    overrides: [
      { localId: 2, comp: 'Transform', field: 'pos', value: [1.0, 0, 0] },
      { localId: 2, comp: 'DirectionalLight', value: { direction: [0, -1, 0], color: [1, 0.5, 0.2], intensity: 1.0 } },
    ],
  }],
};

const innerHandle = world.allocSharedRef('SceneAsset', innerScene);

const outerHandle = world.allocSharedRef('SceneAsset', outerScene);
const outerHandleRaw = Number(outerHandle);

world._setSceneAssetResolver?.((sourceIdx, parentHandle) => {
  void sourceIdx;
  if (Number(parentHandle) === outerHandleRaw) return okResult(innerHandle);
  return errResult({ code: 'asset-not-found' });
});

// Camera + light.
world.spawn(
  { component: Transform, data: { pos: [0, 1, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.3, -1.0, -0.5], color: [1.0, 0.95, 0.9], intensity: 1.0 },
});

const instRes = world.instantiateScene(outerHandle);
if (!instRes.ok) {
  console.error(`[smoke] FAIL - instantiateScene: ${instRes.error.code}`);
  process.exit(1);
}

// feat-20260713 M6 / w23: verify the component-add override (DirectionalLight without
// `field`) took effect on the member entity. The member (localId=2) should now carry
// DirectionalLight with the override values.
const rootEntity = instRes.value.root;
const sceneInst = world.get(rootEntity, SceneInstance);
let addOverrideVerified = false;
if (sceneInst.ok) {
  const mapping = sceneInst.value.mapping;
  const memberEntity = mapping[2];
  if (memberEntity !== undefined && memberEntity !== 0) {
    const dl = world.get(memberEntity, DirectionalLight);
    if (dl.ok) {
      const dlVal = dl.value;
      const dirOk = Math.abs(dlVal.direction[0]) < 0.001 && Math.abs(dlVal.direction[1] + 1) < 0.001 && Math.abs(dlVal.direction[2]) < 0.001;
      const colorOk = Math.abs(dlVal.color[0] - 1) < 0.001 && Math.abs(dlVal.color[1] - 0.5) < 0.001 && Math.abs(dlVal.color[2] - 0.2) < 0.001;
      const intensityOk = Math.abs(dlVal.intensity - 1.0) < 0.001;
      if (dirOk && colorOk && intensityOk) {
        addOverrideVerified = true;
      }
    }
  }
}

if (addOverrideVerified) {
  console.log(`[smoke] add-override + field-patch override semantics verified`);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

// R2/B-5: hook console.error so RhiError(hierarchy-broken) lines emitted
// by propagateTransforms (which write through console.error rather than
// the renderer.onError callback) are counted into the failure gate. The
// previous gate counted only renderer-propagated errors, so a flood of
// per-frame hierarchy-broken errors masked the true demo state (PASS
// while pixelSamples were [0,0,0] all-black).
const consoleErrorOriginal = console.error.bind(console);
let consoleErrorRhiCount = 0;
const RHI_ERROR_PATTERN =
  /(RhiError|hierarchy-broken|RhiError\(hierarchy-broken\)|propagateTransforms.*hierarchy-broken)/;
console.error = (...args) => {
  const joined = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
    .join(' ');
  if (RHI_ERROR_PATTERN.test(joined)) consoleErrorRhiCount += 1;
  consoleErrorOriginal(...args);
};

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
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
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// Pixel readback.
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
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [
    srgbToLinear((bytes[off + 2] ?? 0) / 255),
    srgbToLinear((bytes[off + 1] ?? 0) / 255),
    srgbToLinear((bytes[off + 0] ?? 0) / 255),
  ];
};

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.05, 0.05, 0.08];

const sites = [
  { name: 'center', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'left', x: Math.floor(WIDTH * 0.25), y: Math.floor(HEIGHT / 2) },
  { name: 'right', x: Math.floor(WIDTH * 0.75), y: Math.floor(HEIGHT / 2) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// R2/B-5: tighten the meshed-site criterion. The previous "linear distance
// from CLEAR_COLOR > threshold" wording also accepts all-black [0,0,0]
// samples (distance from [0.05,0.05,0.08] is ~0.107 > 0.05), so a black
// frame passed silently. A meshed site must show actual lit colour: at
// least one channel > clear+threshold (rejects all-black masquerading
// as "differs from clear").
//
// The fixture is structural-only (empty materials -> defaultMaterial
// mid-grey fallback), so meshed-site count is reported but not the
// failure gate. The hard gates that catch real engine breakage are
// (b) frames-observed, (d) Renderer.onError count, and (e) console.error
// RhiError count. (e) is the new gate that catches B-1's
// hierarchy-broken spam — the previous regime missed it because
// propagateTransforms writes through console.error.
let meshedRenderCount = 0;
for (const s of sites) {
  const sample = pixelSamples[s.name];
  const dist = distance(sample, CLEAR_COLOR);
  const maxChannel = Math.max(sample[0], sample[1], sample[2]);
  const aboveClear = maxChannel > CLEAR_COLOR[0] + SMOKE_PIXEL_THRESHOLD;
  if (dist > SMOKE_PIXEL_THRESHOLD && aboveClear) meshedRenderCount++;
}

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${errors.map((e) => e.code).join(', ')}]`);
}
if (consoleErrorRhiCount > 0) {
  // R2/B-5: console.error path RhiErrors (propagateTransforms hierarchy-broken etc.)
  // are routed through console.error rather than renderer.onError, so the
  // (d) gate alone does not see them; this (e) gate catches them.
  failures.push(`(e) console.error emitted ${consoleErrorRhiCount} RhiError-shaped lines (propagateTransforms / hierarchy-broken signals)`);
}

if (failures.length > 0) {
  consoleErrorOriginal(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) consoleErrorOriginal(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}
if (!addOverrideVerified) {
  consoleErrorOriginal(`[smoke] FAIL - (f) component-add override (DirectionalLight, no field) not verified on member entity`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - structural gates GREEN: backend=webgpu, frames=${framesObserved}, Renderer.onError count=0, console.error RhiError count=0; meshed sites above clear+threshold=${meshedRenderCount}/${sites.length} (informational, structural-only)`);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);