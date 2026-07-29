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
const canvas = { width, height, getContext(kind) { if (kind !== 'webgpu') return null; return { configure(desc) { target ??= desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); device ??= desc.device; }, unconfigure() {}, getCurrentTexture() { return target; } }; }, addEventListener() {}, removeEventListener() {} };
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => { const adapter = await originalRequestAdapter(options); if (!adapter) return adapter; const requestDevice = adapter.requestDevice.bind(adapter); adapter.requestDevice = async (descriptor) => { device = await requestDevice(descriptor); return device; }; return adapter; };
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { buildTextureAtlasWorld, makeAtlas } = await import(resolve(here, '..', 'src', 'texture-atlas.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}` });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
renderer.onError((error) => errors.push(error));
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);
const world = new World();
const variants = [];
for (const [variant, filter] of [['unpadding', 'linear'], ['padding', 'nearest'], ['unpadding', 'linear'], ['padding', 'nearest']]) {
  const atlas = makeAtlas(variant);
  const texture = { kind: 'texture', width: atlas.size, height: atlas.size, format: 'rgba8unorm-srgb', data: atlas.pixels, colorSpace: 'srgb', mipmap: false };
  const textureHandle = world.allocSharedRef('TextureAsset', texture);
  const upload = await renderer.store.uploadTexture(textureHandle, texture, { bytes: atlas.pixels, width: atlas.size, height: atlas.size, mime: 'image/png', colorSpace: 'srgb', mipmap: false });
  if (!upload.ok) throw new Error(`${upload.error.code}: ${upload.error.hint}`);
  const samplerHandle = world.allocSharedRef('SamplerAsset', { kind: 'sampler', magFilter: filter, minFilter: filter, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  variants.push({ texture: unwrapHandle(textureHandle), sampler: unwrapHandle(samplerHandle), atlas });
}
buildTextureAtlasWorld(world, variants);
for (let i = 0; i < frames; i += 1) { const result = renderer.draw([world], { owner: 0 }); if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`); }
await device.queue.onSubmittedWorkDone();
const readback = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
device.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const raw = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
let coloredPixels = 0;
let colorBuckets = new Set();
for (let i = 0; i < tight.length; i += 4) {
  const max = Math.max(tight[i], tight[i + 1], tight[i + 2]);
  const min = Math.min(tight[i], tight[i + 1], tight[i + 2]);
  if (max - min > 35 && max > 40) { coloredPixels += 1; colorBuckets.add(`${tight[i] >> 5}:${tight[i + 1] >> 5}:${tight[i + 2] >> 5}`); }
}
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'texture-atlas.png'), writeReferencePng(tight, width, height));
console.log(`[smoke] frames=${frames} coloredPixels=${coloredPixels} colorBuckets=${colorBuckets.size} errors=${errors.length}`);
if (renderer.backend !== 'webgpu' || frames < 100 || coloredPixels < 1500 || colorBuckets.size < 4 || errors.length > 0) { console.error('[smoke] FAIL - atlas variants must be visible with multiple sprite colors and zero RHI errors'); process.exit(1); }
console.log('[smoke] PASS - backend=webgpu, visible padded/unpadded atlas variants, errors=0');
device.destroy?.();
