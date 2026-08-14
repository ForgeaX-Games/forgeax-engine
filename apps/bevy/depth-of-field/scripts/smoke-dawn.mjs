#!/usr/bin/env node
// Headless Dawn smoke for Bevy depth_of_field.
// The effect-off/on pair falsifies a depth-independent fullscreen blur.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 220;
const height = 160;
const targetFrames = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10), 300);
const errors = [];

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (error) {
  console.error(`[smoke] FAIL - webgpu import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
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
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
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

const manifestPath = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const shaderPath = resolve(appRoot, 'src', 'depth-of-field.wgsl');
const shaderSource = readFileSync(shaderPath, 'utf8');
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { PostProcessParams, URP_PIPELINE_ID } = await import('@forgeax/engine-render/internal');
const { buildDepthOfFieldWorld, DOF_MODE_BOKEH, DOF_MODE_OFF, DOF_PARAM_BYTES, packDofParams } = await import(resolve(appRoot, 'src', 'depth-of-field.ts'));

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.error(`[smoke] FAIL - createRenderer threw: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
renderer.onError((error) => errors.push({ code: error.code, hint: error.hint, detail: error.detail }));
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
const worldAttachment1 = renderer.attachWorld(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildDepthOfFieldWorld(world, width / height);
const effectId = 'bevy-depth-of-field::camera';
const offParams = packDofParams(7, 0.8, DOF_MODE_OFF);
const onParams = packDofParams(7, 0.8, DOF_MODE_BOKEH);
const paramsEntity = world.spawn({ component: PostProcessParams, data: { shader: effectId, data: offParams } }).unwrap();
renderer.postProcess.register(effectId, {
  source: shaderSource,
  reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
  params: { byteSize: DOF_PARAM_BYTES, defaultValue: onParams },
});

function installEffect(enabled) {
  const result = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
    config: { postEffects: enabled ? [effectId] : [] },
  });
  if (!result.ok) throw new Error(`installPipeline(${enabled ? 'on' : 'off'}): ${result.error.code} - ${result.error.hint}`);
}

function drawFrames(count) {
  let failures = 0;
  for (let i = 0; i < count; i += 1) {
    world.update().unwrap();
    const result = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!result.ok) failures += 1;
  }
  return failures;
}

async function capturePixels() {
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return pixels;
}

function compare(left, right) {
  let total = 0;
  let changedPixels = 0;
  let visiblePixels = 0;
  for (let i = 0; i < left.length; i += 4) {
    const diff = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]);
    total += diff;
    if (diff > 3) changedPixels += 1;
    if (right[i] + right[i + 1] + right[i + 2] > 24) visiblePixels += 1;
  }
  return { mean: total / (width * height * 3), changedPixels, visiblePixels };
}

let framesObserved = 0;
let drawErrors = 0;
const firstHalf = Math.floor(targetFrames / 3);
installEffect(true);
drawErrors += drawFrames(firstHalf);
framesObserved += firstHalf;
const offPixels = await capturePixels();
world.set(paramsEntity, PostProcessParams, { data: onParams });
const secondHalf = Math.floor(targetFrames / 3);
drawErrors += drawFrames(secondHalf);
framesObserved += secondHalf;
const onPixels = await capturePixels();
const passNames = [...renderer.perFramePassNames];
const remainder = targetFrames - firstHalf - secondHalf;
drawErrors += drawFrames(remainder);
framesObserved += remainder;

const offPng = resolve(appRoot, 'artifacts', 'dof-off.png');
const onPng = resolve(appRoot, 'artifacts', 'dof-on.png');
mkdirSync(dirname(offPng), { recursive: true });
writeFileSync(offPng, writeReferencePng(offPixels, width, height));
writeFileSync(onPng, writeReferencePng(onPixels, width, height));
const diff = compare(offPixels, onPixels);
console.log(`[bevy-depth-of-field] backend=${renderer.backend} sceneMeshes=${scene.meshCount}`);
console.log(`[smoke] frames=${framesObserved} dofDiffMean=${diff.mean.toFixed(4)} changedPixels=${diff.changedPixels} visiblePixels=${diff.visiblePixels} passes=${passNames.join(',')}`);
console.log(`[smoke] off=${offPng} on=${onPng}`);
if (errors.length > 0) console.log(`[smoke] rendererErrorsDetail=${JSON.stringify(errors.slice(0, 3))}`);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (framesObserved < targetFrames) failures.push(`frames=${framesObserved} < ${targetFrames}`);
if (drawErrors > 0) failures.push(`drawErrors=${drawErrors}`);
if (errors.length > 0) failures.push(`rendererErrors=${errors.map((error) => error.code).join(',')}`);
if (diff.visiblePixels < 1000) failures.push(`visiblePixels=${diff.visiblePixels} < 1000`);
if (diff.mean <= 0.05 || diff.changedPixels <= 100) failures.push(`DOF off/on diff too small: mean=${diff.mean.toFixed(4)}, changedPixels=${diff.changedPixels}`);
if (!passNames.includes('post-effect-0')) failures.push(`missing post-effect-0: ${passNames.join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice.destroy?.();
  process.exit(1);
}
console.log('[smoke] PASS - depth read, live params, 300 frames, post-effect, and pixel falsifier are GREEN');
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
await delay(0);
