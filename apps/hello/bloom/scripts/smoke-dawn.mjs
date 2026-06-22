#!/usr/bin/env node
// hello-bloom headless smoke (feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w19).
//
// Strategy: createApp, spawn emissive sphere + cube scene with
// bloom-enabled Camera, start the app, run N frames, and assert the
// bloom pipeline compiled and drew without errors.
//
// This smoke verifies the full createApp -> bloom pipeline chain:
//   1. createApp(canvas, opts) succeeds.
//   2. renderer.ready succeeds (bloom shaders compiled as part of manifest).
//   3. app.start() + N-frame loop + app.stop() succeeds.
//   4. app.onError fires 0 times (covers pipeline compile + draw errors).
//   5. console.error fires 0 times.
//   6. frames >= SMOKE_MIN_FRAMES.
//   7. The per-frame render graph contains the 4 declarative bloom
//      passes (bloom-bright / bloom-blur-h / bloom-blur-v / bloom-composite)
//      — proves the bloom chain is wired in the compiled graph.
//   8. bug-20260622 resize guard (AC-01/AC-02/AC-07): after the original
//      frames, shrink the swap-chain texture and drive more frames without
//      settling. The recompile drains the old-size bloom transient pool while
//      a prior command buffer may still be in flight. Asserts zero NEW
//      app.onError during the resize phase — the immediate-destroy regression
//      raises "Destroyed texture used in a submit" through onuncapturederror.
//      This is the only smoke that walks the resize-then-render bug path.
//
// Structural-only (OOS-3): no pixel readback. HDR float cross-device
// rounding makes pixel diff unreliable. The bloom pipeline verdict is
// structural: 0 RhiError + 0 console.error + frames >= 300 + 4 bloom
// passes present in the compiled render graph (bloom-bright / bloom-blur-h
// / bloom-blur-v / bloom-composite). Proves the declarative chain is wired;
// mirrors hello-physics structural smoke.
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual error codes and frame count so AI users can self-diagnose.

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

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

// bug-20260622: the swap-chain texture dimensions drive recordFrame's
// targetW/targetH (read off getCurrentTexture().width/height). Switching the
// returned texture to a smaller one mid-run makes the render-graph
// setSwapChainSize() report needsRecompile -> recompile -> drainTransient(),
// which retires the old-size bloom transient pool textures. The deferred-
// destroy fix (pendingDestroy + reclaimRetiredTransients) must keep those
// textures alive until the in-flight command buffer retires; the old buggy
// path destroyed them immediately and the next queue.submit raised
// "Destroyed texture used in a submit", surfaced via onuncapturederror ->
// app.onError. This resize step is the only smoke that walks that path.
let renderTarget;
let renderTargetW = WIDTH;
let renderTargetH = HEIGHT;
let renderTargetFormat = 'rgba8unorm';
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTargetFormat = format;
  renderTarget = device.createTexture({
    size: { width: renderTargetW, height: renderTargetH, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
function resizeRenderTarget(device, width, height) {
  renderTargetW = width;
  renderTargetH = height;
  const next = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: renderTargetFormat,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTarget = next;
  return next;
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
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  HANDLE_CUBE,
  HANDLE_SPHERE,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} = runtimePkg;

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, {
    input: false,
}, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-bloom] backend=${app.renderer.backend}`);

// Register standard PBR material (non-emissive).
const assets = app.renderer.assets;
if (assets === null) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const matHandle = app.world.allocSharedRef('MaterialAsset', {
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
    baseColor: [0.7, 0.7, 0.7],
    metallic: 0.0,
    roughness: 0.4,
  },
});

// Mint emissive material (emissiveIntensity > 1.0 feeds bloom).
const emissiveHandle = app.world.allocSharedRef('MaterialAsset', {
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
    baseColor: [1.0, 0.85, 0.55],
    metallic: 0.0,
    roughness: 0.3,
    emissive: [1.0, 0.7, 0.3],
    emissiveIntensity: 2.0,
  },
});

// Spawn emissive sphere (left) and non-emissive cube (right).
app.world.spawn(
  {
    component: Transform,
    data: { posX: -0.6, posY: 0.2, posZ: 0, quatW: 1, scaleX: 0.6, scaleY: 0.6, scaleZ: 0.6 },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [emissiveHandle] } },
);

app.world.spawn(
  {
    component: Transform,
    data: { posX: 0.6, posY: 0, posZ: 0, quatW: 1, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);

// Directional light.
app.world.spawn({
  component: DirectionalLight,
  data: { directionX: -0.4, directionY: -0.6, directionZ: -0.7, colorR: 1, colorG: 1, colorB: 1, intensity: 1.5 },
});

// Camera with bloom ENABLED.
app.world.spawn(
  { component: Transform, data: { posZ: 5 } },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      tonemap: TONEMAP_REINHARD_EXTENDED,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomBlurRadius: 4.0,
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

// Override performance.now for deterministic frame timing.
let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

// Run frames at the original size.
let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
}

// bug-20260622 resize step (AC-01/AC-02/AC-07): shrink the swap-chain texture
// and immediately drive more frames WITHOUT settling. The first post-resize
// frame recompiles the render graph (setSwapChainSize -> drainTransient) while
// the prior frame's command buffer may still be in flight on the GPU. The
// deferred-destroy fix must keep the retired transient textures alive until
// reclaimRetiredTransients() observes onSubmittedWorkDone; the old buggy path
// destroyed them synchronously and the next queue.submit raised
// "Destroyed texture used in a submit", caught here via app.onError.
const RESIZE_W = Math.max(1, Math.floor(WIDTH / 2));
const RESIZE_H = Math.max(1, Math.floor(HEIGHT / 2));
const onErrorBeforeResize = onErrorEvents.length;
if (sharedDevice) {
  resizeRenderTarget(sharedDevice, RESIZE_W, RESIZE_H);
  mockCanvas.width = RESIZE_W;
  mockCanvas.height = RESIZE_H;
}
console.log(`[smoke] resize ${WIDTH}x${HEIGHT} -> ${RESIZE_W}x${RESIZE_H}`);
const RESIZE_FRAMES = 60;
let resizeFrames = 0;
for (let i = 0; i < RESIZE_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  resizeFrames++;
  totalFrames++;
}

// Restore real performance.now and wait for any pending GPU work to settle.
globalThis.performance.now = realPerformanceNow;
await delay(2000);

const onErrorAfterResize = onErrorEvents.length;
console.log(
  `[smoke] frames observed=${totalFrames} (resize phase=${resizeFrames}, onError pre-resize=${onErrorBeforeResize}, post-resize=${onErrorAfterResize})`,
);

// (d) Per-frame graph must contain the 4 declarative bloom passes.
// Snapshot before app.stop() — feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle
// changed createApp().stop() to chain renderer.dispose(), which clears
// frameState.perFrameGraph as part of the dispose 6-step cascade. Reading
// renderer.perFramePassNames after stop now correctly returns []; smoke
// must inspect graph state during the live phase.
const bloomPassNames = ['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite'];
const actualPassNames = app.renderer.perFramePassNames;

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const failures = [];
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}

// Filter out known smoke-expected noise: the '[smoke]' prefix on our own logs.
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(`(b) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
}

if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// Proves the bloom chain is wired in the compiled render graph. When bloom
// is disabled (camera.bloom !== 'on') the passes are still in the graph
// but early-return inside their execute closures — this assertion still
// catches the case where bloom passes are accidentally removed from the
// graph (a real regression, e.g. a bad merge or a refactor that drops the
// addPass calls).
const missingBloomPasses = bloomPassNames.filter((n) => !actualPassNames.includes(n));
if (missingBloomPasses.length > 0) {
  failures.push(`(d) bloom passes missing from per-frame graph: ${JSON.stringify(missingBloomPasses)} (actual: ${JSON.stringify(actualPassNames)})`);
}

// bug-20260622 (e): the resize phase must not surface any new GPU validation
// error. A "Destroyed texture used in a submit" (immediate-destroy regression)
// fans out through onuncapturederror -> app.onError, incrementing onErrorEvents
// during the post-resize frames. onErrorBeforeResize === onErrorAfterResize
// proves the deferred-destroy fix keeps retired transients alive across the
// in-flight command buffer. resizeFrames > 0 guards against the resize phase
// silently skipping (an empty rafQueue would make this assertion vacuous).
if (resizeFrames === 0) {
  failures.push('(e) resize phase ran 0 frames; resize smoke is vacuous (rafQueue drained early)');
} else if (onErrorAfterResize !== onErrorBeforeResize) {
  const resizeErrors = onErrorEvents.slice(onErrorBeforeResize);
  failures.push(
    `(e) resize introduced ${onErrorAfterResize - onErrorBeforeResize} app.onError event(s) (destroyed-texture-in-submit regression?): ${JSON.stringify(resizeErrors)}`,
  );
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, app.onError=0, bloomPasses=${bloomPassNames.length}/4, resize=${WIDTH}x${HEIGHT}->${RESIZE_W}x${RESIZE_H} (${resizeFrames}f, 0 new onError), backend=${app.renderer.backend}`);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);