#!/usr/bin/env node
// bevy-ssao headless dawn smoke (structural + pixel falsifier).
// The same occlusion-heavy scene is rendered with HDRP SSAO disabled and
// enabled. The readbacks must differ, while the enabled graph exposes both
// SSAO passes and completes the 300-frame gate without renderer errors.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const WIDTH = 200;
const HEIGHT = 150;

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
    sharedDevice ??= device;
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
    usage: 0x10 | 0x04 | 0x01,
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

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { HDRP_PIPELINE_ID } = await import('@forgeax/engine-render/internal');
const { buildSsaoWorld } = await import(resolve(here, '..', 'src', 'ssao.ts'));

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[bevy-ssao] backend=${renderer.backend}`);
const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
const worldAttachment1 = renderer.attachWorld(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildSsaoWorld(world, WIDTH / HEIGHT);
console.log(`[bevy-ssao] scene meshes=${scene.meshCount}`);

function installSsao(enabled) {
  const result = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: {
      clusterGrid: { x: 16, y: 9, z: 24 },
      ssao: enabled ? { enabled: true, radius: 0.65, bias: 0.025, intensity: 1.4 } : { enabled: false },
    },
  });
  if (!result.ok) throw new Error(`installPipeline(${enabled ? 'on' : 'off'}): ${result.error.code} - ${result.error.hint}`);
}

async function capturePixels() {
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
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

const targetFrames = Math.max(SMOKE_MIN_FRAMES, 300);
let framesObserved = 0;
let drawErrors = 0;
function drawFrames(count) {
  for (let i = 0; i < count; i += 1) {
    world.update().unwrap();
    const result = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!result.ok) {
      drawErrors += 1;
      console.error(`[smoke] draw frame ${framesObserved} error: ${result.error.code}`);
    }
    framesObserved += 1;
  }
}

installSsao(false);
drawFrames(Math.floor(targetFrames / 3));
const ssaoOffPixels = await capturePixels();
installSsao(true);
drawFrames(Math.floor(targetFrames / 3));
const ssaoOnPixels = await capturePixels();
const passNames = renderer.perFramePassNames;
drawFrames(targetFrames - 2 * Math.floor(targetFrames / 3));

const diff = meanByteDiff(ssaoOffPixels, ssaoOnPixels);
const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const offPng = resolve(artifactDir, 'ssao-off.png');
const onPng = resolve(artifactDir, 'ssao-on.png');
writeFileSync(offPng, writeReferencePng(ssaoOffPixels, WIDTH, HEIGHT));
writeFileSync(onPng, writeReferencePng(ssaoOnPixels, WIDTH, HEIGHT));

await sharedDevice.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} ssaoDiffMean=${diff.mean.toFixed(4)} changedPixels=${diff.changedPixels} passes=${passNames.join(',')} off=${offPng} on=${onPng}`);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) failures.push(`(c) Renderer.onError fired ${errors.length} times: [${errors.map((e) => e.code).join(', ')}]`);
if (drawErrors > 0) failures.push(`(c) draw returned ${drawErrors} errors`);
if (diff.mean <= 0.05 || diff.changedPixels <= 20) failures.push(`(d) SSAO on/off diff too small: mean=${diff.mean.toFixed(4)}, changedPixels=${diff.changedPixels}`);
for (const pass of ['ssao-calc', 'ssao-blur']) {
  if (!passNames.includes(pass)) failures.push(`(e) missing SSAO pass ${pass}; actual=${passNames.join(',')}`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  sharedDevice.destroy?.();
  process.exit(1);
}

console.log('[smoke] PASS - backend, 300 frames, zero errors, SSAO graph, and pixel discrimination are GREEN');
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
await delay(0);
