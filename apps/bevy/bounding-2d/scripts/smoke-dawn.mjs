#!/usr/bin/env node
// Headless proof for Bevy's `bounding_2d` reproduction.
//
// The rendered scene proves the app's real World/camera path is alive. The in-process
// checks prove every interactive mode calls the new engine-math owner: AABB overlap,
// circle overlap, finite raycasts, AABB sweeps, and circle sweeps.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.10');
const WIDTH = 320;
const HEIGHT = 180;

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
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const device = await originalRequestDevice(desc);
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

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const here = dirname(fileURLToPath(import.meta.url));
const {
  BOUNDING_2D_TESTS,
  buildBounding2dWorld,
  computeBounding2dState,
  drawBounding2d,
  volumeCount,
} = await import(resolve(here, '..', 'src', 'bounding-2d.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-bounding-2d] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push(err.code));
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
buildBounding2dWorld(world);
propagateTransforms(world);

const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}

let frame;
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const result = renderer.draw([world], { owner: 0 });
  if (!result.ok) console.error(`[smoke] draw frame ${i} error: ${result.error.code}`);
  framesObserved++;
  if (i === 5) frame = await capture(sharedDevice);
}
if (!sharedDevice || !frame) {
  console.error('[smoke] FAIL - render target readback was not initialized');
  process.exit(1);
}

let maxBright = 0;
for (let i = 0; i < frame.length; i += 4) {
  maxBright = Math.max(maxBright, (frame[i] ?? 0) / 255, (frame[i + 1] ?? 0) / 255, (frame[i + 2] ?? 0) / 255);
}
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);
console.log(`[smoke] maxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

const modeResults = [];
for (const mode of BOUNDING_2D_TESTS) {
  const state = computeBounding2dState(1.25, mode);
  const calls = [];
  const captureDraw = {
    line() { calls.push('line'); },
    arrow() { calls.push('arrow'); },
    aabb() { calls.push('aabb'); },
    sphere() { calls.push('sphere'); },
    frustum() { calls.push('frustum'); },
    axes() { calls.push('axes'); },
  };
  drawBounding2d(captureDraw, state);
  const hitCount = state.boxHits.filter(Boolean).length + state.circleHits.filter(Boolean).length;
  modeResults.push({ mode, hitCount, drawCalls: calls.length });
}
console.log(`[smoke] modes=${modeResults.length} (expected ${BOUNDING_2D_TESTS.length})`);
console.log(`[smoke] modeHits=${modeResults.map(({ mode, hitCount }) => `${mode}:${hitCount}`).join(',')}`);
console.log(`[smoke] drawCalls=${modeResults.map(({ mode, drawCalls }) => `${mode}:${drawCalls}`).join(',')}`);

try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const out = process.env.SMOKE_PNG_OUT ?? resolve(outDir, 'smoke-frame.png');
  writeFileSync(out, writeReferencePng(frame, WIDTH, HEIGHT));
  console.log(`[smoke] wrote PNG=${out}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (maxBright <= SMOKE_BRIGHT_FLOOR) failures.push(`frame maxBright=${maxBright.toFixed(4)} <= ${SMOKE_BRIGHT_FLOOR}`);
if (modeResults.length !== BOUNDING_2D_TESTS.length) failures.push('not all bounding modes ran');
if (modeResults.some(({ hitCount, drawCalls }) => hitCount === 0 || drawCalls < volumeCount())) {
  failures.push('one bounding mode produced no hit or too few draw calls');
}
if (errors.length > 0) failures.push(`Renderer.onError fired ${errors.length}x: [${errors.join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  sharedDevice.destroy?.();
  process.exit(1);
}
sharedDevice.destroy?.();
console.log(`[smoke] PASS - backend=webgpu, frames=${framesObserved}, modes=${modeResults.length}, maxBright=${maxBright.toFixed(4)}, draw/error gates green`);
