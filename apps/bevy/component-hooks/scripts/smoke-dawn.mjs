#!/usr/bin/env node
// Headless Dawn smoke for the component_hooks reproduction.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMES = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10), 180);
const WIDTH = 320;
const HEIGHT = 180;
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
let target;
function ensureTarget(nextDevice, format) {
  if (target) return target;
  target = nextDevice.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return target;
}
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { return ensureTarget(device, 'rgba8unorm'); },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device = await requestDevice(descriptor);
    return device;
  };
  return adapter;
};

const here = dirname(fileURLToPath(import.meta.url));
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildComponentHooksWorld, readComponentHooksState } = await import(resolve(here, '..', 'src', 'component-hooks.ts'));
let renderer;
try {
  renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
const errors = [];
renderer.onError((error) => errors.push(error.code));
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`renderer.ready: ${ready.error.code}`);
const world = new World();
const worldAttachment1 = renderer.attachWorld(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const state = buildComponentHooksWorld(world);
for (let frame = 0; frame < FRAMES; frame++) {
  world.update(0.016).unwrap();
  const draw = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
  if (!draw.ok) throw new Error(`draw ${frame}: ${draw.error.code}`);
}
await device.queue.onSubmittedWorkDone();
const snapshot = readComponentHooksState(world, state);
console.log(`[smoke] state=${JSON.stringify(snapshot)}`);
const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (snapshot.add !== 2 || snapshot.insert !== 3) failures.push(`insertions=${snapshot.add}/${snapshot.insert}`);
if (snapshot.discard !== 2 || snapshot.remove !== 1) failures.push(`removals=${snapshot.discard}/${snapshot.remove}`);
if (snapshot.indexSize !== 1 || snapshot.rekey !== 3 || snapshot.remaining !== 0) failures.push(`index=${JSON.stringify(snapshot)}`);
if (errors.length > 0) failures.push(`RhiErrors=${errors.join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  device.destroy?.();
  process.exit(1);
}
console.log(`[smoke] PASS - frames=${FRAMES}, four lifecycle hooks and index evidence verified`);
device.destroy?.();
delete globalThis.navigator.gpu;
