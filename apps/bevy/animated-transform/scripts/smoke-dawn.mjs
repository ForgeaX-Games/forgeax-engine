#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const WIDTH = 320;
const HEIGHT = 180;
const here = dirname(fileURLToPath(import.meta.url));

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const device = await originalRequestDevice(desc);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        renderTarget ??= desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) throw new Error('render target was not configured');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

async function capture() {
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

const { World } = await import('@forgeax/engine-ecs');
const { animationPlugin } = await import('@forgeax/engine-animation');
const { scenePlugin } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildAnimatedTransformWorld, readAnimatedTransformState } = await import(
  resolve(here, '..', 'src', 'animated-transform.ts'),
);
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;
const renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code}`);
  process.exit(1);
}
console.log(`[bevy-animated-transform] backend=${renderer.backend}`);

const world = new World();
if (!(await scenePlugin().build(world)).ok) process.exit(1);
if (!(await animationPlugin().build(world)).ok) process.exit(1);
const state = buildAnimatedTransformWorld(world);
const before = await captureAfterFrame(0);
const earlyState = readAnimatedTransformState(world, state);
let lateFrame = before;
for (let frame = 1; frame < SMOKE_MIN_FRAMES; frame++) {
  world.update(1 / 60);
  renderer.draw([world], { owner: 0 });
  if (frame === SMOKE_MIN_FRAMES - 1) {
    await delay(30);
    lateFrame = await capture();
  }
}
const lateState = readAnimatedTransformState(world, state);

async function captureAfterFrame(dt) {
  if (dt > 0) world.update(dt);
  renderer.draw([world], { owner: 0 });
  await delay(30);
  return capture();
}

function diff(a, b) {
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    const value = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += value;
    if (value > 3) pixels++;
  }
  return { pixels, mean: sum / (WIDTH * HEIGHT) };
}

mkdirSync(resolve(here, '..', 'artifacts'), { recursive: true });
writeFileSync(resolve(here, '..', 'artifacts', 'frame-early.png'), writeReferencePng(before, WIDTH, HEIGHT));
writeFileSync(resolve(here, '..', 'artifacts', 'frame-late.png'), writeReferencePng(lateFrame, WIDTH, HEIGHT));
const motion = diff(before, lateFrame);
const checks = [
  ['backend=webgpu', renderer.backend === 'webgpu'],
  ['planet-translation-animated', Math.abs((lateState.planet.pos[0] ?? 0) - (earlyState.planet.pos[0] ?? 0)) > 0.01],
  ['orbit-rotation-animated', Math.abs((lateState.orbitController.quat[1] ?? 0) - (earlyState.orbitController.quat[1] ?? 0)) > 0.01],
  ['satellite-scale-animated', Math.abs((lateState.satellite.scale[0] ?? 0) - (earlyState.satellite.scale[0] ?? 0)) > 0.01],
  ['render-motion-pixels', motion.pixels > 100],
  ['rhi-error-count=0', errors.length === 0],
];
let all = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) all = false;
}
console.log(`[smoke] frames observed=${SMOKE_MIN_FRAMES} motionMeanDelta=${motion.mean.toFixed(4)}`);
if (!all) {
  console.error(`[smoke] FAIL - motionPixels=${motion.pixels} errors=${errors.length}`);
  process.exit(1);
}
console.log('[smoke] PASS');
