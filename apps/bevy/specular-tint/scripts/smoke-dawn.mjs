#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const tintGuid = '019e3969-1d46-79d1-9d22-ffd8c6859c64';
const errors = [];
const { create, globals } = await import('webgpu');
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
  adapter.requestDevice = async (descriptor) => { const device = await originalRequestDevice(descriptor); sharedDevice ??= device; return device; };
  return adapter;
};
let renderTarget;
function ensureRenderTarget(device, format) { renderTarget ??= device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x04 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); return renderTarget; }
const mockCanvas = { tagName: 'CANVAS', isConnected: true, width, height, getContext(kind) { if (kind !== 'webgpu') return null; return { configure(d) { ensureRenderTarget(d.device, d.format ?? 'rgba8unorm'); }, unconfigure() {}, getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); } }; }, addEventListener() {}, removeEventListener() {} };
const rafQueue = [];
globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(await buildEngineShaderManifest()))}`;
const { createApp } = await import('@forgeax/engine-app');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { createDevImportTransport } = await import('@forgeax/engine-runtime');
const { buildSpecularTintWorld } = await import(resolve(appRoot, 'src', 'specular-tint.ts'));
const distDir = resolve(appRoot, 'dist');
const packIndex = JSON.parse(readFileSync(resolve(distDir, 'pack-index.json'), 'utf8'));
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
const tintEntry = packIndex.find((entry) => entry.guid === tintGuid);
if (!hdrEntry || !tintEntry) { console.error('[smoke] missing specular tint assets'); process.exit(1); }
const bytesFor = (entry) => new Uint8Array(readFileSync(resolve(distDir, entry.relativeUrl.replace(/^\//, ''))));
const hdrBytes = bytesFor(hdrEntry); const tintBytes = bytesFor(tintEntry);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === '/pack-index.json') return { ok: true, json: () => Promise.resolve(packIndex), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  if (url === hdrEntry.relativeUrl) return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(hdrBytes.buffer.slice(hdrBytes.byteOffset, hdrBytes.byteOffset + hdrBytes.byteLength)) };
  if (url === tintEntry.relativeUrl) return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(tintBytes.buffer.slice(tintBytes.byteOffset, tintBytes.byteOffset + tintBytes.byteLength)) };
  return originalFetch(url);
};
const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) { console.error(`[smoke] createApp failed: ${appResult.error.code}`); process.exit(1); }
const app = appResult.value;
app.renderer.onError((error) => errors.push(error)); app.onError((error) => errors.push(error));
const ready = await app.renderer.ready;
if (!ready.ok) { console.error(`[smoke] renderer.ready failed: ${ready.error.code}`); process.exit(1); }
const hdrParsed = AssetGuid.parse(hdrGuid); const tintParsed = AssetGuid.parse(tintGuid);
if (!hdrParsed.ok || !tintParsed.ok) { console.error('[smoke] GUID parse failed'); process.exit(1); }
app.renderer.assets.configurePackIndex('/pack-index.json');
const hdr = await app.renderer.assets.loadByGuid(hdrParsed.value); const tint = await app.renderer.assets.loadByGuid(tintParsed.value);
if (!hdr.ok || !tint.ok) { console.error(`[smoke] asset load failed: ${hdr.ok ? tint.error.code : hdr.error.code}`); process.exit(1); }
const equirect = app.world.allocSharedRef('EquirectAsset', hdr.value);
const texture = app.world.allocSharedRef('TextureAsset', tint.value);
buildSpecularTintWorld(app.world, equirect, unwrapHandle(texture), width / height);
const started = app.start();
if (!started.ok) { console.error(`[smoke] app.start failed: ${started.error.code}`); process.exit(1); }
const frameStartTimestamp = performance.now(); let frames = 0;
for (let i = 0; i < targetFrames; i += 1) { const callback = rafQueue.shift(); if (!callback) break; callback(frameStartTimestamp + i * 16.67); frames += 1; if (i % 16 === 15) { await sharedDevice.queue.onSubmittedWorkDone(); await delay(1); } }
await sharedDevice.queue.onSubmittedWorkDone(); app.stop();
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
sharedDevice.queue.submit([encoder.finish()]); await readback.mapAsync(0x01);
const mapped = new Uint8Array(readback.getMappedRange().slice(0)); readback.unmap(); readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true }); writeFileSync(pngOut, writeReferencePng(tight, width, height));
const patchMean = (x0, x1, y0, y1) => { const sum = [0, 0, 0]; let count = 0; for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const index = (y * width + x) * 4; sum[0] += tight[index] ?? 0; sum[1] += tight[index + 1] ?? 0; sum[2] += tight[index + 2] ?? 0; count += 1; } return sum.map((value) => value / count / 255); };
const neutral = patchMean(25, 95, 45, 145); const solid = patchMean(125, 195, 45, 145); const mappedPatch = patchMean(225, 295, 45, 145);
let maxLuma = 0; for (let i = 0; i < tight.length; i += 4) maxLuma = Math.max(maxLuma, ((tight[i] ?? 0) * 0.299 + (tight[i + 1] ?? 0) * 0.587 + (tight[i + 2] ?? 0) * 0.114) / 255);
const failures = [];
if (app.renderer.backend !== 'webgpu') failures.push(`backend=${app.renderer.backend}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
if (maxLuma <= 0.02) failures.push(`specular tint scene is dark: maxLuma=${maxLuma.toFixed(4)}`);
if (Math.abs(solid[0] - neutral[0]) + Math.abs(solid[1] - neutral[1]) + Math.abs(solid[2] - neutral[2]) <= 0.01) failures.push(`solid tint missing: neutral=${neutral.map((value) => value.toFixed(4)).join(',')} solid=${solid.map((value) => value.toFixed(4)).join(',')}`);
if (Math.abs(mappedPatch[0] - neutral[0]) + Math.abs(mappedPatch[1] - neutral[1]) + Math.abs(mappedPatch[2] - neutral[2]) <= 0.01) failures.push(`texture-map witness missing: neutral=${neutral.map((value) => value.toFixed(4)).join(',')} mapped=${mappedPatch.map((value) => value.toFixed(4)).join(',')}`);
console.log(`[smoke] backend=${app.renderer.backend} frames=${frames} neutral=${neutral.map((value) => value.toFixed(4)).join(',')} solid=${solid.map((value) => value.toFixed(4)).join(',')} mapped=${mappedPatch.map((value) => value.toFixed(4)).join(',')} png=${pngOut}`);
if (failures.length > 0) { console.error(`[smoke] FAIL - ${failures.join('; ')}`); sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(1); }
console.log('[smoke] PASS - neutral, solid-tinted, and texture-mapped dielectric specular witnesses rendered with zero engine errors');
sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(0);
