#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const width = 320;
const height = 180;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const here = dirname(fileURLToPath(import.meta.url));

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
let target;
const canvas = {
  width, height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
        device ??= desc.device;
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device = await requestDevice(descriptor);
    return device;
  };
  return adapter;
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { BLOOM_DISABLED, BLOOM_ENABLED, Camera } = await import('@forgeax/engine-render');
const { buildBloom2dWorld } = await import(resolve(here, '..', 'dist', 'bloom-2d.mjs')).catch(async () => import(resolve(here, '..', 'src', 'bloom-2d.ts')));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
renderer.onError((error) => errors.push(error));
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);

const world = new World();
const scene = buildBloom2dWorld(world);
console.log(`[bloom-2d] backend=${renderer.backend} quads=${scene.quadCount} bright=${scene.brightCount}`);

async function capture() {
  await device.queue.onSubmittedWorkDone();
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

function draw(count) {
  let drawErrors = 0;
  for (let i = 0; i < count; i += 1) if (!renderer.draw([world], { owner: 0 }).ok) drawErrors += 1;
  return drawErrors;
}

world.set(scene.camera, Camera, { bloom: BLOOM_DISABLED });
const offErrors = draw(Math.max(1, Math.floor(frames / 3)));
const offPixels = await capture();
world.set(scene.camera, Camera, { bloom: BLOOM_ENABLED });
const onErrors = draw(Math.max(1, Math.floor(frames / 3)));
const onPixels = await capture();
const remaining = frames - Math.floor(frames / 3) * 2;
const tailErrors = draw(Math.max(0, remaining));
const passNames = renderer.perFramePassNames;

let totalDiff = 0;
let changedPixels = 0;
let visiblePixels = 0;
for (let i = 0; i < offPixels.length; i += 4) {
  const off = Math.abs(offPixels[i] - onPixels[i]) + Math.abs(offPixels[i + 1] - onPixels[i + 1]) + Math.abs(offPixels[i + 2] - onPixels[i + 2]);
  totalDiff += off;
  if (off > 3) changedPixels += 1;
  if (Math.max(onPixels[i], onPixels[i + 1], onPixels[i + 2]) > 12) visiblePixels += 1;
}
const diffMean = totalDiff / (width * height * 3);
const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(resolve(artifactDir, 'bloom-2d-off.png'), writeReferencePng(offPixels, width, height));
writeFileSync(resolve(artifactDir, 'bloom-2d-on.png'), writeReferencePng(onPixels, width, height));
console.log(`[smoke] frames=${frames} visiblePixels=${visiblePixels} bloomDiffMean=${diffMean.toFixed(4)} changedPixels=${changedPixels} errors=${errors.length + offErrors + onErrors + tailErrors} passes=${passNames.join(',')}`);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (frames < 100) failures.push(`frames=${frames}`);
if (visiblePixels < 100) failures.push(`visiblePixels=${visiblePixels}`);
if (diffMean <= 0.25 || changedPixels <= 20) failures.push(`bloomDiffMean=${diffMean.toFixed(4)} changedPixels=${changedPixels}`);
if (errors.length + offErrors + onErrors + tailErrors > 0) failures.push(`errors=${errors.length + offErrors + onErrors + tailErrors}`);
for (const pass of ['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite']) if (!passNames.includes(pass)) failures.push(`missing=${pass}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  device.destroy?.();
  process.exit(1);
}
console.log('[smoke] PASS - 2D bright meshes visible and bloom on/off differs');
device.destroy?.();
delete globalThis.navigator.gpu;
