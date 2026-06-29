#!/usr/bin/env node
// hello-hdrp-lighting headless smoke (feat-20260609-hdrp-cluster-fragment-ggx M5 / w20).
//
// Upgraded from structural-only to pixel readback ε <= 0.05 vs committed
// baseline PNG. The 256-light scene renders through HDRP cluster-forward;
// the smoke engine routes bootstrap + dawn-node + mock canvas + render
// loop + pixel readback + per-pixel delta vs baseline (AC-01).
//
// FALSIFY=force-urp -- skips installPipeline; pixel must differ > 0.05
//   from HDRP baseline (proves smoke discriminability).
// FALSIFY=cluster-grid-zero -- sets FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO=1;
//   pixel diff vs HDRP baseline must exceed 0.05 (AC-10 falsifiability).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReferencePng, readReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_EPSILON = Number.parseFloat(process.env.SMOKE_PIXEL_EPSILON ?? '0.05');
const FALSIFY = process.env.FALSIFY ?? '';

const here = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = resolve(here, '..', '..', '..', '..');
const BASELINE_PATH = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  '.forgeax-harness',
  'forgeax-loop',
  'feat-20260609-hdrp-cluster-fragment-ggx',
  'screenshots',
  'hdrp-lighting-256-light-dawn.png',
);

// 200x150 keeps 4:3 aspect (camera fov / aspect numbers below stay valid)
// but cuts fragment work to 1/16 of 800x600. Lavapipe in CI is fully CPU-
// bound on the cluster-forward fragment shader (every pixel iterates O(30-
// 60) lights), so the smaller canvas drops the CI step from ~160s to ~10s.
// The pixel readback gate still catches PSO variant misroute / cluster-grid
// FALSIFY because the cube + floor + light-driven gradient occupy roughly
// the same proportion of the frame -- this is a CPU cost cut, not a coverage
// cut. Baseline regenerated under forgeax-engine-assets/.../screenshots/.
const WIDTH = 200;
const HEIGHT = 150;

// Known-noise app.onError codes during 256-light HDRP demo.
const KNOWN_NOISE_CODES = new Set([
  'hdrp-light-budget-exceeded',
  'hdrp-index-list-overflow',
]);

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// FALSIFY=cluster-grid-zero: inject falsify env var before engine loads.
if (FALSIFY === 'cluster-grid-zero') {
  process.env.FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO = '1';
}

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
const realPerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

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
  tagName: 'CANVAS',
  isConnected: true,
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

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const runtimePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  HANDLE_CUBE,
  HDRP_PIPELINE_ID,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SpotLight,
  TONEMAP_ACES_FILMIC,
  Transform,
} = runtimePkg;

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-hdrp-lighting] backend=${app.renderer.backend}`);

const assets = app.renderer.assets;
if (assets === null) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const world = app.world;

let installSuccess = false;
if (FALSIFY === 'force-urp') {
  console.log('[smoke] FALSIFY=force-urp -- skipping installPipeline(hdrpHandle)');
} else {
  const installRes = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: { clusterGrid: { x: 16, y: 9, z: 24 } },
  });
  if (!installRes.ok) {
    originalConsoleError(`[smoke] FAIL - installPipeline: ${installRes.error.code} - ${installRes.error.hint}`);
    process.exit(1);
  }
  installSuccess = true;
}

const matHandle = world.allocSharedRef('MaterialAsset', {
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
    baseColor: [0.6, 0.6, 0.65],
    metallic: 0.0,
    roughness: 0.6,
  },
});

world.spawn(
  { component: Transform, data: { posX: 0, posY: -0.5, posZ: 0, quatW: 1, scaleX: 6, scaleY: 0.1, scaleZ: 6 } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0.6, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x484452_50);
// Light geometry MUST stay in sync with apps/hello/hdrp-lighting/src/main.ts
// (the demo SSOT). y above the cube top + range >= ground gap ensure both
// floor and cube faces receive healthy NdotL. range 2.5..4.0m fits the new
// 1 MiB LIGHT_INDEX_LIST_CAPACITY with grid 16x9x24.
for (let i = 0; i < 200; i++) {
  const x = (rng() - 0.5) * 5.5;
  const z = (rng() - 0.5) * 5.5;
  const y = 1.5 + rng() * 2.0;
  world.spawn(
    { component: Transform, data: { posX: x, posY: y, posZ: z, quatW: 1 } },
    {
      component: PointLight,
      data: {
        colorR: 0.5 + 0.5 * rng(),
        colorG: 0.5 + 0.5 * rng(),
        colorB: 0.5 + 0.5 * rng(),
        intensity: 0.3 + 0.4 * rng(),
        range: 2.5 + 1.5 * rng(),
      },
    },
  );
}
for (let i = 0; i < 56; i++) {
  const x = (rng() - 0.5) * 5.5;
  const z = (rng() - 0.5) * 5.5;
  const y = 2.0 + rng() * 2.0;
  world.spawn(
    { component: Transform, data: { posX: x, posY: y, posZ: z, quatW: 1 } },
    {
      component: SpotLight,
      data: {
        directionX: rng() - 0.5,
        directionY: -1,
        directionZ: rng() - 0.5,
        colorR: 0.5 + 0.5 * rng(),
        colorG: 0.5 + 0.5 * rng(),
        colorB: 0.5 + 0.5 * rng(),
        intensity: 0.5 + 0.5 * rng(),
        range: 2.5 + 1.5 * rng(),
        innerConeDeg: 18,
        outerConeDeg: 32,
      },
    },
  );
}

// Camera placed at eye height (y=1.5) looking horizontal toward -Z so the
// 1x1 cube at (0, 0.6, 0) and the 6x0.1x6 floor are both inside the fov=45deg
// frustum from z=6.0. Original (y=4.0) pitched the lookat below the bottom of
// the frustum (atan2(3.4, 6.0) ~ 30deg > fov/2 = 22.5deg) -- the cube was
// drawn (632 successful drawIndexed across 332 frames) but landed off-screen,
// so the readback PNG returned only the camera clearColor.
world.spawn(
  { component: Transform, data: { posX: 0, posY: 1.5, posZ: 6.0, quatW: 1 } },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearR: 0.02,
      clearG: 0.02,
      clearB: 0.04,
      // 256 punctual lights at intensity 1.5..4.0 produce HDR radiance that
      // burns out without a tonemap. ACES filmic + exposure 0.6 keeps mid-
      // tones visible while letting hot spots roll off naturally.
      tonemap: TONEMAP_ACES_FILMIC,
      exposure: 0.6,
    },
  },
);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));

const ready = await app.renderer.ready;
if (!ready.ok) {
  originalConsoleError(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  // Yield to microtask + macrotask each frame so async shader-module pre-bake
  // promises (rhi-webgpu's createShaderModule + getCompilationInfo) settle and
  // the next raf cb hits the warmed module cache instead of returning the
  // pending 'rhi-not-available' err for 300 straight frames.
  if (i % 16 === 15) await delay(1);
}

globalThis.performance.now = realPerformanceNow;
await delay(2000);

// After warmup, drain any newly queued raf cbs so the post-warmup PSOs land
// in materialShaderPipelineCache and get used for the final readback frame.
for (let i = 0; i < 32; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  if (i % 8 === 7) await delay(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

// --- Pixel readback -----------------------------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
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

const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const dst = (y * WIDTH + x) * 4;
    tightRgba[dst + 0] = bytes[off + 0] ?? 0;
    tightRgba[dst + 1] = bytes[off + 1] ?? 0;
    tightRgba[dst + 2] = bytes[off + 2] ?? 0;
    tightRgba[dst + 3] = bytes[off + 3] ?? 0;
  }
}

// --- Verdict ------------------------------------------------------------------

const failures = [];

// (a) backend check
if (app.renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${app.renderer.backend} (expected webgpu)`);
}

// (b) frame count
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// (c) app.onError filtered to unknown codes
const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(c) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

// FALSIFY modes: diff vs baseline.
const falsifyClusterGridZero = FALSIFY === 'cluster-grid-zero';
const falsifyForceUrp = FALSIFY === 'force-urp';

if (!existsSync(BASELINE_PATH)) {
  const png = writeReferencePng(tightRgba, WIDTH, HEIGHT);
  writeFileSync(BASELINE_PATH, png);
  console.error(
    `[smoke] baseline PNG WRITTEN to ${BASELINE_PATH} (no prior baseline). ` +
      `Inspect and commit this file; rerun smoke to enter COMPARED mode.`,
  );
  failures.push('(e) baseline PNG missing -- first-run WRITTEN; commit then rerun');
} else {
  const ref = readReferencePng(BASELINE_PATH);
  if (ref.width !== WIDTH || ref.height !== HEIGHT) {
    failures.push(`(e) baseline PNG size mismatch: ${ref.width}x${ref.height} != ${WIDTH}x${HEIGHT}`);
  } else {
    let maxDelta = 0;
    let exceedCount = 0;
    for (let i = 0; i < ref.pixels.length; i += 4) {
      const dr = Math.abs((ref.pixels[i] ?? 0) - (tightRgba[i] ?? 0)) / 255;
      const dg = Math.abs((ref.pixels[i + 1] ?? 0) - (tightRgba[i + 1] ?? 0)) / 255;
      const db = Math.abs((ref.pixels[i + 2] ?? 0) - (tightRgba[i + 2] ?? 0)) / 255;
      const d = Math.max(dr, dg, db);
      if (d > maxDelta) maxDelta = d;
      if (d > SMOKE_PIXEL_EPSILON) exceedCount++;
    }
    console.log(`[smoke] pixelDelta=${JSON.stringify({ maxDelta: maxDelta.toFixed(4), exceedCount })}`);
    if (falsifyClusterGridZero || falsifyForceUrp) {
      // Falsify modes must FAIL -- diff must exceed threshold.
      const exceedRatio = exceedCount / (WIDTH * HEIGHT);
      if (exceedRatio < 0.001) {
        failures.push(
          `(e) AC-10 falsify ${FALSIFY}: expected pixel diff > eps=${SMOKE_PIXEL_EPSILON} but only ${exceedCount} pixels exceeded (ratio=${exceedRatio.toFixed(6)}, maxDelta=${maxDelta.toFixed(4)}) -- smoke NOT discriminative`,
        );
        // When the baseline PNG is all-black (pre-rebake state), falsify
        // cannot produce a difference because the rendering is already
        // black. Re-bake the baseline (delete the PNG and re-run smoke)
        // after verifying HDRP rendering is producing lit output.
        if (maxDelta < 0.001) {
          console.warn(`[smoke] hint: maxDelta=${maxDelta.toFixed(4)} suggests baseline PNG is all-black; verify HDRP rendering produces lit pixels, then delete ${BASELINE_PATH} and re-run smoke to re-bake`);
        }
      } else {
        console.log(`[smoke] AC-10 falsify ${FALSIFY} FAIL as expected: ${exceedCount} pixels exceed eps=${SMOKE_PIXEL_EPSILON} (max=${maxDelta.toFixed(4)})`);
      }
    } else if (exceedCount > 0) {
      failures.push(
        `(e) AC-01 pixel readback drift: ${exceedCount} pixels exceed eps=${SMOKE_PIXEL_EPSILON} (max=${maxDelta.toFixed(4)})`,
      );
    }
  }
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=${app.renderer.backend}, frames=${totalFrames}, hdrpInstalled=${installSuccess}, app.onError-known-noise-only=${onErrorEvents.length}, console.error=0`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
