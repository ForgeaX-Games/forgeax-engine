#!/usr/bin/env node
// hello-physics headless smoke.
//
// Strategy: createApp with physicsPlugin('rapier-3d'), spawn a dynamic sphere +
// static ground scene, start the app, poll for PhysicsWorld (async WASM), then
// run N frames with working tick systems, and assert the sphere's Transform pos y
// has decreased (gravity-driven free-fall).
//
// This smoke verifies the full createApp -> physics tick pipeline:
//   1. createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }) succeeds.
//   2. app.start() + N-frame loop + app.stop() succeeds.
//   3. PhysicsWorld resource is inserted into World after WASM init.
//   4. Dynamic RigidBody has Transform pos y strictly lower than initial
//      after simulation advances (verifying the three-phase tick systems
//      -- physicsSyncBackend, physicsStepSimulation, physicsWriteback --
//      are registered and running, AC-04).
//
// Note: physicsPlugin.build awaits the Rapier WASM import -- runPlugins in
// createApp resolves after the WASM module is loaded, so PhysicsWorld is
// populated before the first app frame. If the WASM fails to load within
// the timeout, the smoke FAILs (non-vacuous PASS).

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const WASM_LOAD_TIMEOUT_MS = Number.parseInt(process.env.FORGEAX_SMOKE_PHYSICS_WASM_TIMEOUT_MS ?? '10000', 10);

const WIDTH = 800;
const HEIGHT = 600;

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
const { Camera, DirectionalLight, Transform } = runtimePkg;

const physicsPkg = await import('@forgeax/engine-physics');
const { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue, physicsPlugin } = physicsPkg;

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, {
  plugins: [physicsPlugin('rapier-3d')],
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
console.log(`[hello-physics] backend=${app.renderer.backend}`);

// Spawn the physics scene.
app.world.spawn(
  { component: Transform, data: { pos: [0, -2, 0], scale: [10, 0.5, 10]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], restitution: 0.3 },
  },
);

const sphereSpawn = app.world.spawn(
  { component: Transform, data: { pos: [0, 5, 0]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.01 } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.sphere, radius: 0.5, restitution: 0.7, friction: 0.5 },
  },
);
if (!sphereSpawn.ok) {
  originalConsoleError(`[smoke] FAIL - sphere spawn failed: ${sphereSpawn.error.code} - ${sphereSpawn.error.hint}`);
  process.exit(1);
}
const sphereEntity = sphereSpawn.value;

app.world.spawn(
  { component: Transform, data: { pos: [8, 4, 10]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
app.world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

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

// Read initial sphere pos y before simulation.
const initialTransform = app.world.get(sphereEntity, Transform);
if (!initialTransform.ok) {
  originalConsoleError(`[smoke] FAIL - initial Transform read failed: ${initialTransform.error.code}`);
  process.exit(1);
}
const initialPosY = initialTransform.value.pos[1];
console.log(`[smoke] sphere initial pos y=${initialPosY}`);

// Run frames. The WASM loads asynchronously; early frames have no physics,
// but once PhysicsWorld appears the tick systems activate.
let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
}

// Restore real performance.now and wait for any pending WASM to settle.
globalThis.performance.now = realPerformanceNow;
await delay(2000);

const hasPhysicsWorld = app.world.hasResource('PhysicsWorld') === true;
console.log(`[smoke] frames observed=${totalFrames}, PhysicsWorld=${hasPhysicsWorld}`);

const finalTransform = app.world.get(sphereEntity, Transform);
if (!finalTransform.ok) {
  originalConsoleError(`[smoke] FAIL - final Transform read failed: ${finalTransform.error.code}`);
  process.exit(1);
}
const finalPosY = finalTransform.value.pos[1];
console.log(`[smoke] sphere final pos y=${finalPosY}`);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const failures = [];
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}
if (consoleErrors.length > 0) {
  const physicsErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
  if (physicsErrors.length > 0) {
    failures.push(`(b) console.error fired ${physicsErrors.length} times: ${JSON.stringify(physicsErrors.slice(0, 3))}`);
  }
}
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// AC-04: PhysicsWorld must be present (physicsPlugin awaits WASM import before
// createApp resolves). Dynamic RigidBody must have pos y strictly lower than
// initial after simulation frames advance.
if (!hasPhysicsWorld) {
  failures.push(`(d) PhysicsWorld not present -- WASM did not load or physicsPlugin build failed`);
} else if (finalPosY >= initialPosY) {
  failures.push(`(e) sphere pos y did not decrease: ${initialPosY} -> ${finalPosY} (delta=${(finalPosY - initialPosY).toFixed(4)})`);
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, PhysicsWorld=${hasPhysicsWorld}, pos y: ${initialPosY} -> ${finalPosY}, app.onError=0`);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);