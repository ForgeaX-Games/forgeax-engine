#!/usr/bin/env node
// bevy-bloom headless dawn smoke (pixel falsifier + structural gate).
// Strategy: the shared Bevy-faithful 10x10 emissive sphere field is rendered
// with bloom off and on; the two readbacks must differ.
//   (a) backend=webgpu
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) Renderer.onError count == 0
//   (d) bloom-on vs bloom-off pixel readback differs materially

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);

const WIDTH = 200;
const HEIGHT = 150;

// --- dawn.node setup ---

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
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
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

// --- Build scene ---

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { BLOOM_DISABLED, BLOOM_ENABLED, Camera } = await import('@forgeax/engine-render');

const world = new World();

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[bloom] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const { buildBloomWorld } = await import(resolve(here, '..', 'src', 'bloom.ts'));
const scene = buildBloomWorld(world, WIDTH / HEIGHT);
console.log(`[bloom] scene spheres=${scene.sphereCount} emissive=${scene.emissiveCount}`);

async function capturePixels() {
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  return pixels;
}

function meanByteDiff(left, right) {
  let total = 0;
  let changedPixels = 0;
  for (let i = 0; i < left.length; i += 4) {
    const diff = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]);
    total += diff;
    if (diff > 3) changedPixels += 1;
  }
  return { mean: total / (WIDTH * HEIGHT * 3), changedPixels };
}

// --- Frame loop ---

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const phaseFrames = Math.max(1, Math.floor(TARGET_FRAMES / 3));
let framesObserved = 0;
let drawErrors = 0;
const drawPhase = (count) => {
  for (let i = 0; i < count; i += 1) {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) { drawErrors += 1; console.error(`[smoke] draw frame ${framesObserved} error: ${r.error.code}`); }
    framesObserved += 1;
  }
};

world.set(scene.camera, Camera, { bloom: BLOOM_DISABLED });
drawPhase(phaseFrames);
const bloomOffPixels = await capturePixels();
world.set(scene.camera, Camera, { bloom: BLOOM_ENABLED });
drawPhase(phaseFrames);
const bloomOnPixels = await capturePixels();
const passNames = renderer.perFramePassNames;
drawPhase(TARGET_FRAMES - phaseFrames * 2);

const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const offPng = resolve(artifactDir, 'bloom-off.png');
const onPng = resolve(artifactDir, 'bloom-on.png');
writeFileSync(offPng, writeReferencePng(bloomOffPixels, WIDTH, HEIGHT));
writeFileSync(onPng, writeReferencePng(bloomOnPixels, WIDTH, HEIGHT));

const device = sharedDevice;
if (device) await device.queue.onSubmittedWorkDone();
const diff = meanByteDiff(bloomOffPixels, bloomOnPixels);
console.log(`[smoke] frames observed=${framesObserved} bloomDiffMean=${diff.mean.toFixed(4)} changedPixels=${diff.changedPixels} passes=${passNames.join(',')} off=${offPng} on=${onPng}`);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${errors.map((e) => e.code).join(', ')}]`);
}
if (drawErrors > 0) failures.push(`(c) draw returned ${drawErrors} errors`);
if (diff.mean <= 0.25 || diff.changedPixels <= 20) failures.push(`(d) bloom on/off diff too small: mean=${diff.mean.toFixed(4)}, changedPixels=${diff.changedPixels}`);
for (const pass of ['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite']) {
  if (!passNames.includes(pass)) failures.push(`(e) missing bloom pass ${pass}; actual=${passNames.join(',')}`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0`);
device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
