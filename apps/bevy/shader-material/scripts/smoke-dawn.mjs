#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10), 300);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
let renderTarget;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
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

const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
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

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { makeTextureAsset, makeTexturePixels, buildShaderMaterialWorld, SHADER_ID, TEXTURE_SIZE } = await import(resolve(root, 'src', 'scene.ts'));

const manifest = JSON.parse(readFileSync(resolve(root, 'dist', 'shaders', 'manifest.json'), 'utf8'));
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
let renderer;
try {
  renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-shader-material] backend=${renderer.backend}`);
const errors = [];
renderer.onError((error) => errors.push(error));
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);

const shaderEntry = (manifest.materialShaders ?? []).find((entry) => entry?.identifier === SHADER_ID);
const shaderRegistry = renderer.shader;
if (shaderRegistry === null || shaderEntry === undefined) throw new Error('shader material manifest entry missing');
if (!shaderRegistry.lookupMaterialShader(SHADER_ID).ok) {
  shaderRegistry.registerMaterialShader(SHADER_ID, {
    source: shaderEntry.composedWgsl,
    paramSchema: JSON.parse(shaderEntry.paramSchema),
  });
}

const pixels = makeTexturePixels();
const texture = makeTextureAsset(pixels);
const world = new World();
const textureHandle = world.allocSharedRef('TextureAsset', texture);
const upload = await renderer.store.uploadTexture(textureHandle, texture, {
  bytes: pixels,
  width: TEXTURE_SIZE,
  height: TEXTURE_SIZE,
  mime: 'image/png',
  colorSpace: 'srgb',
  mipmap: false,
});
if (!upload.ok) throw new Error(`${upload.error.code}: ${upload.error.hint}`);
if (!buildShaderMaterialWorld(world, unwrapHandle(textureHandle))) throw new Error('scene construction failed');

for (let frame = 0; frame < FRAMES; frame += 1) {
  const draw = renderer.draw([world], { owner: 0 });
  if (!draw.ok) throw new Error(`${draw.error.code}: ${draw.error.hint}`);
  await delay(0);
}
await sharedDevice.queue.onSubmittedWorkDone();
if (!renderTarget) throw new Error('render target was not allocated');

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
const padded = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const framePixels = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y += 1) framePixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);

const pngPath = process.env.SMOKE_PNG_OUT ?? resolve(root, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, writeReferencePng(framePixels, WIDTH, HEIGHT));
let visiblePixels = 0;
let brightPixels = 0;
const colors = new Set();
for (let i = 0; i < framePixels.length; i += 4) {
  const r = framePixels[i] ?? 0;
  const g = framePixels[i + 1] ?? 0;
  const b = framePixels[i + 2] ?? 0;
  if (r + g + b > 30) visiblePixels += 1;
  if (r + g + b > 300) brightPixels += 1;
  colors.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
}
console.log(`[smoke] frames=${FRAMES} visiblePixels=${visiblePixels} brightPixels=${brightPixels} colorBins=${colors.size} errors=${errors.length} png=${pngPath}`);
const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (visiblePixels < 500) failures.push(`visiblePixels=${visiblePixels} < 500`);
if (brightPixels < 20) failures.push(`brightPixels=${brightPixels} < 20`);
if (colors.size < 8) failures.push(`colorBins=${colors.size} < 8 (texture/color path is not visible)`);
if (errors.length > 0) failures.push(`Renderer.onError=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - custom material texture, color uniform, and alpha-blended render path are visible');
sharedDevice.destroy?.();
