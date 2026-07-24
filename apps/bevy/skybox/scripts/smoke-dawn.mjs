#!/usr/bin/env node
// Dawn smoke for Bevy's 3d/skybox reproduction.
// FALSIFY=remove-skybox removes the component and must remove the skybox pass.

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
const falsify = process.env.FALSIFY ?? '';
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
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
      getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = rafId++;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
const { createApp } = await import('@forgeax/engine-app');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { createDevImportTransport } = await import('@forgeax/engine-runtime');
const { buildSkyboxWorld } = await import(resolve(appRoot, 'src', 'skybox.ts'));

const distDir = resolve(appRoot, 'dist');
const packIndexPath = resolve(distDir, 'pack-index.json');
let packIndex;
try {
  packIndex = JSON.parse(readFileSync(packIndexPath, 'utf8'));
} catch (error) {
  console.error(`[smoke] FAIL - cannot read ${packIndexPath}; run the demo build first: ${error}`);
  process.exit(1);
}
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
if (!hdrEntry) {
  console.error(`[smoke] FAIL - HDR GUID ${hdrGuid} is absent from ${packIndexPath}`);
  process.exit(1);
}
const hdrBytes = new Uint8Array(readFileSync(resolve(distDir, hdrEntry.relativeUrl.replace(/^\//, ''))));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === '/pack-index.json') {
    return { ok: true, json: () => Promise.resolve(packIndex), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  }
  if (url === hdrEntry.relativeUrl) {
    const buffer = new ArrayBuffer(hdrBytes.byteLength);
    new Uint8Array(buffer).set(hdrBytes);
    return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(buffer) };
  }
  return originalFetch(url);
};

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) {
  console.error(`[smoke] FAIL - createApp: ${appResult.error.code} - ${appResult.error.hint}`);
  process.exit(1);
}
const app = appResult.value;
app.renderer.onError((error) => errors.push(error));
app.onError((error) => errors.push(error));
const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const guidResult = AssetGuid.parse(hdrGuid);
if (!guidResult.ok) {
  console.error(`[smoke] FAIL - AssetGuid.parse: ${guidResult.error.code}`);
  process.exit(1);
}
const assets = app.renderer.assets;
assets.configurePackIndex('/pack-index.json');
const hdrResult = await assets.loadByGuid(guidResult.value);
if (!hdrResult.ok) {
  console.error(`[smoke] FAIL - loadByGuid HDR: ${hdrResult.error.code} - ${hdrResult.error.hint}`);
  process.exit(1);
}

const world = app.world;
const equirect = world.allocSharedRef('EquirectAsset', hdrResult.value);
buildSkyboxWorld(world, equirect, width / height, { includeSkybox: falsify !== 'remove-skybox' });

const started = app.start();
if (!started.ok) {
  console.error(`[smoke] FAIL - app.start: ${started.error.code} - ${started.error.hint}`);
  process.exit(1);
}

let frames = 0;
let passNames = [];
for (let i = 0; i < targetFrames; i += 1) {
  const due = rafQueue.shift();
  if (!due) break;
  due.callback(i * 16.67);
  frames += 1;
  if (i === 4) passNames = [...app.renderer.perFramePassNames];
  if (i % 16 === 15) {
    await sharedDevice.queue.onSubmittedWorkDone();
    await delay(1);
  }
}
for (let pass = 0; pass < 4; pass += 1) {
  await sharedDevice.queue.onSubmittedWorkDone();
  await delay(250);
}
for (let i = 0; i < 32; i += 1) {
  const due = rafQueue.shift();
  if (!due) break;
  due.callback((targetFrames + i) * 16.67);
  frames += 1;
  if (i % 8 === 7) await sharedDevice.queue.onSubmittedWorkDone();
}
passNames = [...app.renderer.perFramePassNames];
app.stop();

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
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, writeReferencePng(tight, width, height));

let maxLuma = 0;
for (let i = 0; i < tight.length; i += 4) {
  maxLuma = Math.max(maxLuma, ((tight[i] ?? 0) * 0.299 + (tight[i + 1] ?? 0) * 0.587 + (tight[i + 2] ?? 0) * 0.114) / 255);
}
const hasSkybox = passNames.includes('skybox');
const failures = [];
if (app.renderer.backend !== 'webgpu') failures.push(`backend=${app.renderer.backend}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
if (falsify !== 'remove-skybox' && !hasSkybox) failures.push(`skybox pass missing: ${JSON.stringify(passNames)}`);
if (maxLuma <= 0.02) failures.push(`${falsify === 'remove-skybox' ? 'FALSIFY removed skybox and darkened frame' : 'HDR skybox is dark'}: maxLuma=${maxLuma.toFixed(4)}`);
console.log(`[smoke] backend=${app.renderer.backend}`);
console.log(`[smoke] frames=${frames} passNames=${JSON.stringify(passNames)} maxLuma=${maxLuma.toFixed(4)} png=${pngOut}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - HDR skybox rendered with zero engine errors');
process.exit(0);
