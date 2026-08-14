#!/usr/bin/env node
// bevy-plugin-group headless Dawn smoke — proves group expansion through createApp.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '100', 10);
const WIDTH = 160;
const HEIGHT = 120;

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (error) {
  console.error(`[smoke] FAIL - dawn-node create: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    if (!sharedDevice) sharedDevice = device;
    return device;
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
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) { ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { quat } = await import('@forgeax/engine-math');
const here = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const { createApp } = await import('@forgeax/engine-app');
const { helloWorldPlugins } = await import(resolve(here, '..', 'src', 'plugin-group.ts'));

const consoleLogCalls = [];
const originalLog = console.log;
console.log = (...args) => consoleLogCalls.push(args.join(' '));

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.log = originalLog;
  console.error(`[smoke] FAIL - createRenderer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const errors = [];
renderer.onError((error) => errors.push({ code: error.code, hint: error.hint }));
const ready = await renderer.ready;
if (!ready.ok) {
  console.log = originalLog;
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code}`);
  process.exit(1);
}

const eye = [-2, 2.5, 5];
const world = new World();
const worldAttachment1 = renderer.attachWorld(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
world.spawn(
  { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);
const appResult = await createApp({ renderer, world, plugins: [helloWorldPlugins] });
if (!appResult.ok) {
  console.log = originalLog;
  console.error(`[smoke] FAIL - createApp: ${appResult.error.code}`);
  process.exit(1);
}

for (let index = 0; index < SMOKE_MIN_FRAMES; index += 1) {
  world.update(0.016);
  await renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
}
await delay(50);
console.log = originalLog;

const registryOrder = [...appResult.value.pluginRegistry.keys()];
const firstHello = consoleLogCalls.findIndex((entry) => entry === 'hello');
const firstWorld = consoleLogCalls.findIndex((entry) => entry === 'world');
const checks = [
  ['backend=webgpu', renderer.backend === 'webgpu'],
  ['rhi-error-count=0', errors.length === 0],
  ['group-order=hello,world', registryOrder.join(',') === 'print-hello,print-world'],
  ['system-order=hello-before-world', firstHello >= 0 && firstWorld > firstHello],
];

let allPass = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) allPass = false;
}
if (!allPass) {
  console.error(`[smoke] FAIL - ${checks.filter(([, pass]) => !pass).map(([name]) => name).join(', ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, backend=${renderer.backend}`);
process.exit(0);
