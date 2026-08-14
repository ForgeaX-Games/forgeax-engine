#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const WIDTH = 320;
const HEIGHT = 180;
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FRAME_COUNT = Math.max(MIN_FRAMES, 300);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
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

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure: (descriptor) => ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'),
      unconfigure() {},
      getCurrentTexture: () => ensureRenderTarget(sharedDevice, 'rgba8unorm'),
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const manifest = JSON.parse(readFileSync(resolve(root, 'dist', 'shaders', 'manifest.json'), 'utf8'));
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { quat } = await import('@forgeax/engine-math');
const { Transform } = await import('@forgeax/engine-scene');

let renderer;
try {
  renderer = await createRenderer(canvas, {}, { shaderManifestUrl: manifestUrl });
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-animate-shader] backend=${renderer.backend}`);
const errors = [];
renderer.onError((error) => errors.push(error));
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);

const shaderId = 'bevy::animate_shader';
const shaderEntry = (manifest.materialShaders ?? []).find((entry) => entry?.identifier === shaderId);
const shaderRegistry = renderer.shader;
if (shaderRegistry === null || shaderEntry === undefined) throw new Error('animate shader manifest entry missing');
if (!shaderRegistry.findMaterialArtifact(shaderId).ok) {
  shaderRegistry.installMaterialArtifact(shaderId, {
    source: shaderEntry.composedWgsl,
    paramSchema: JSON.parse(shaderEntry.paramSchema),
  });
}

const geometry = createBoxGeometry(1, 1, 1);
if (!geometry.ok) throw new Error(`${geometry.error.code}: ${geometry.error.hint}`);
const world = new World();
const worldAttachment1 = renderer.attachWorld(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const mesh = world.allocSharedRef('MeshAsset', geometry.value);
const values = { time: 0 };
const material = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: shaderId }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values,
});
world.spawn(
  { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: mesh } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
const eye = [-2, 2.5, 5];
world.spawn(
  { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.5, 0], [0, 1, 0]), scale: [1, 1, 1] } },
  { component: Camera, data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
}).unwrap();

const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
const captures = [];
async function capture(label) {
  await sharedDevice.queue.onSubmittedWorkDone();
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  const pngPath = resolve(root, 'artifacts', `frame-${label}.png`);
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, writeReferencePng(pixels, WIDTH, HEIGHT));
  captures.push({ label, pixels, pngPath });
}

for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  values.time = frame / 60;
  world.update().unwrap();
  const draw = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
  if (!draw.ok) console.error(`[smoke] draw frame ${frame} error: ${draw.error.code}`);
  await delay(0);
  if (frame === 60) await capture('early');
  if (frame === FRAME_COUNT - 1) await capture('late');
}

function meanDelta(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (a.length / 4) / 765;
}
function maxLuma(pixels) {
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255);
  return max;
}
const early = captures[0];
const late = captures[1];
const pixelDelta = early && late ? meanDelta(early.pixels, late.pixels) : 0;
const lateLuma = late ? maxLuma(late.pixels) : 0;
console.log(`[smoke] frames observed=${FRAME_COUNT}`);
console.log(`[smoke] pixelDelta=${pixelDelta.toFixed(5)} lateMaxLuma=${lateLuma.toFixed(4)}`);
for (const capture of captures) console.log(`[smoke] wrote PNG=${capture.pngPath}`);
const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`backend=${renderer.backend}`);
if (FRAME_COUNT < MIN_FRAMES) failures.push(`frames=${FRAME_COUNT} < ${MIN_FRAMES}`);
if (lateLuma <= 0.15) failures.push(`lateMaxLuma=${lateLuma.toFixed(4)} <= 0.15`);
if (pixelDelta <= 0.0005) failures.push(`pixelDelta=${pixelDelta.toFixed(5)} <= 0.0005 (shader animation is frozen)`);
if (errors.length > 0) failures.push(`Renderer.onError=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - time-driven Oklab shader animation changed the rendered frame');
sharedDevice.destroy?.();
