#!/usr/bin/env node
// Dawn-node smoke for Bevy's text2d mapping.
//
// The browser app and this smoke both call src/text2d.ts. Dawn cannot fetch a
// Vite pack-index, so this script registers the same baked DejaVu MSDF payload
// inline and then drives the public World + renderer path for deterministic
// readback.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const framesTarget = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const width = 320;
const height = 180;
const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(process.env.SMOKE_ARTIFACT_DIR ?? resolve(here, '..', 'artifacts'));
mkdirSync(artifactDir, { recursive: true });

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width, height, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() { return renderTarget; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app');
const { Update } = await import('@forgeax/engine-ecs');
const { MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { Text2dMotion, registerSharedSampler, buildText2dWorld, stepText2d } = await import(resolve(here, '..', 'src', 'text2d.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

const result = await createApp(mockCanvas, {}, { shaderManifestUrl: manifestUrl }).catch((error) => {
  console.error(`[smoke] FAIL - createApp threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
gpu.requestAdapter = originalRequestAdapter;
if (!result.ok) {
  console.error(`[smoke] FAIL - createApp: ${result.error.code}`);
  process.exit(1);
}
const app = result.value;
console.log(`[bevy-text2d] backend=${app.renderer.backend}`);
const errors = [];
app.onError((error) => errors.push({ code: error.code, hint: error.hint }));
const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code}`);
  process.exit(1);
}
const attachment = app.renderer.attachWorld(app.world);
if (!attachment.ok) throw attachment.error;

const assets = app.renderer.assets;
if (assets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
registerSharedSampler(assets);
const fontPayload = await registerBakedFont(app.world, assets);
const scene = buildText2dWorld(app.world, fontPayload);
app.world.addSystem(Update, {
  name: 'text2d-motion',
  queries: [],
  fn: (world) => stepText2d(world, scene, 1 / 60),
});

const attached = () => [scene.translation, scene.rotation, scene.scale, scene.multiline]
  .filter((entity) => worldGet(entity, MeshFilter) && worldGet(entity, MeshRenderer)).length;
const worldGet = (entity, component) => app.world.get(entity, component).ok;
let frames = 0;
for (let i = 0; i < framesTarget; i++) {
  const updated = app.world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - world.update frame=${i}: ${updated.error.code}`);
    process.exit(1);
  }
  const drawn = app.renderer.draw([app.world], { cameraOwner: 0, resourceOwner: 0 });
  if (!drawn.ok) console.error(`[smoke] draw frame=${i}: ${drawn.error.code}`);
  frames++;
  await delay(0);
}
await delay(100);

const pixels = await readback(sharedDevice);
writeFileSync(resolve(artifactDir, 'text2d.png'), writeReferencePng(pixels, width, height));
const visiblePixels = countVisiblePixels(pixels);
const motion = app.world.get(scene.translation, Text2dMotion);
const motionPhase = motion.ok ? motion.value.phase : 0;
const metrics = { backend: app.renderer.backend, frames, attachedGlyphMeshes: attached(), motionPhase, visiblePixels, rhiErrors: errors.length };
writeFileSync(resolve(artifactDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`[smoke] frames observed=${frames}`);
console.log(`[smoke] GlyphText meshes attached=${metrics.attachedGlyphMeshes}/4`);
console.log(`[smoke] translation motion phase=${motionPhase.toFixed(3)}`);
console.log(`[smoke] visible pixels=${visiblePixels}`);
console.log(`[smoke] wrote PNG=${resolve(artifactDir, 'text2d.png')}`);

const failures = [];
if (app.renderer.backend !== 'webgpu') failures.push(`backend=${app.renderer.backend}`);
if (frames < framesTarget) failures.push(`frames=${frames}<${framesTarget}`);
if (metrics.attachedGlyphMeshes !== 4) failures.push(`GlyphText mesh attachment=${metrics.attachedGlyphMeshes}/4`);
if (motionPhase <= 0) failures.push(`motionPhase=${motionPhase} did not advance`);
if (visiblePixels < 150) failures.push(`visiblePixels=${visiblePixels}<150`);
if (errors.length > 0) failures.push(`renderer errors=${JSON.stringify(errors.slice(0, 3))}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${frames} frames, 4 GlyphText meshes, ${visiblePixels} visible pixels, rhiErrors=0`);
delete globalThis.navigator.gpu;

async function registerBakedFont(world, assets) {
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const fontDir = resolve(repoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
  const atlasBytes = readFileSync(resolve(fontDir, 'DejaVuSansMono.atlas.png'));
  const pack = JSON.parse(readFileSync(resolve(fontDir, 'DejaVuSansMono.font.pack.json'), 'utf8'));
  const { loadUpng } = await import('@forgeax/engine-image');
  const decoded = (await loadUpng()).decode(atlasBytes, { useTArray: true, formatAsRGBA: true });
  const payload = pack.assets[0].payload;
  const atlas = AssetGuid.parse(payload.atlasGuid);
  const sampler = AssetGuid.parse(payload.samplerGuid);
  if (!atlas.ok || !sampler.ok) throw new Error('font asset GUID parse failed');
  assets.catalog(atlas.value, {
    kind: 'texture',
    width: decoded.width,
    height: decoded.height,
    format: 'rgba8unorm',
    data: decoded.data,
    colorSpace: 'linear',
    mipmap: false,
  });
  return world.allocSharedRef('FontAsset', {
    kind: 'font',
    atlas: atlas.value,
    sampler: sampler.value,
    glyphs: payload.glyphs,
    common: payload.common,
  });
}

async function readback(device) {
  if (!device || !renderTarget) throw new Error('render target unavailable for readback');
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

function countVisiblePixels(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const max = Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    const min = Math.min(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (max > 40 || max - min > 18) count++;
  }
  return count;
}
