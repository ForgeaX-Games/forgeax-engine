#!/usr/bin/env node
// Dawn smoke for Bevy's 3d/fog reproduction.
// FALSIFY=force-no-fog removes the post-effect and must remove the fog pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const fogId = 'bevy-fog::distance';
const fogShaderPath = resolve(appRoot, 'src', 'fog.wgsl');
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
let now = 0;
globalThis.performance.now = () => now;

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

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
const { createApp } = await import('@forgeax/engine-app');
const runtime = await import('@forgeax/engine-runtime');
const { World } = await import('@forgeax/engine-ecs');
const { quat } = await import('@forgeax/engine-math');
const { HANDLE_CUBE, HANDLE_SPHERE } = await import('@forgeax/engine-assets-runtime');
const {
  Camera, Materials, MeshFilter, MeshRenderer, PointLight, PostProcessParams,
  URP_PIPELINE_ID, perspective, Transform,
} = runtime;

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
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

const world = app.world;
const stone = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.16, 0.13, 0.1, 1], roughness: 1 }));
const green = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.03, 0.38, 0.03, 1], metallic: 0.5, roughness: 0.05 }));
for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]]) {
  world.spawn(
    { component: Transform, data: { pos: [x, 1.5, z], scale: [1, 3, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [stone] } },
  ).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [0, 4, 0], scale: [1.75, 1.75, 1.75] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [green] } },
).unwrap();
for (let i = 0; i < 50; i += 1) {
  const halfSize = i / 2 + 3;
  world.spawn(
    { component: Transform, data: { pos: [0, -i / 2 + 0.25, 0], scale: [2 * halfSize, 0.5, 2 * halfSize] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [stone] } },
  ).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [4, 8, 4] } },
  { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 100 } },
).unwrap();
const cameraPosition = [8, 8, 0];
const cameraTarget = [0, 0, 0];
world.spawn(
  { component: Transform, data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]) } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: width / height, near: 0.1, far: 80 }), clearColor: [0.25, 0.25, 0.25, 1] } },
).unwrap();

if (!existsSync(fogShaderPath)) {
  console.error(`[smoke] FAIL - missing fog shader: ${fogShaderPath}`);
  process.exit(1);
}
const fogSource = readFileSync(fogShaderPath, 'utf8');
const shaderSource = falsify === 'force-debug-color'
  ? fogSource.replace(
      '  return vec4<f32>(mix(scene, FOG_COLOR, amount), 1.0);',
      '  return vec4<f32>(1.0, 0.0, 1.0, 1.0);',
    )
  : fogSource;
const paramsBytes = new Uint8Array(new Float32Array([0, 5, 20, 0]).buffer);
app.renderer.postProcess.register(fogId, {
  source: shaderSource,
  reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
  params: { byteSize: 16, defaultValue: paramsBytes },
});
world.spawn({ component: PostProcessParams, data: { shader: fogId, data: paramsBytes } }).unwrap();
const install = app.renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: URP_PIPELINE_ID,
  config: { postEffects: falsify === 'force-no-fog' ? [] : [fogId] },
});
if (!install.ok) {
  console.error(`[smoke] FAIL - installPipeline: ${install.error.code} - ${install.error.hint}`);
  process.exit(1);
}

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
  now += 16.67;
  due.callback(now);
  frames += 1;
  if (i === 4) passNames = [...app.renderer.perFramePassNames];
  if (i % 16 === 15) await delay(1);
}
app.stop();

const device = sharedDevice;
if (!device || !renderTarget) {
  console.error('[smoke] FAIL - no Dawn device/render target');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: renderTarget },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height, depthOrArrayLayers: 1 },
);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const pixels = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();

const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(pixels.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, writeReferencePng(tight, width, height));

let maxBrightness = 0;
let fogCloseCount = 0;
for (let i = 0; i < tight.length; i += 4) {
  const r = (tight[i] ?? 0) / 255;
  const g = (tight[i + 1] ?? 0) / 255;
  const b = (tight[i + 2] ?? 0) / 255;
  maxBrightness = Math.max(maxBrightness, r * 0.299 + g * 0.587 + b * 0.114);
  if (Math.abs(r - 0.25) < 0.06 && Math.abs(g - 0.25) < 0.06 && Math.abs(b - 0.25) < 0.06) fogCloseCount += 1;
}
const hasPostEffect = passNames.some((name) => name.startsWith('post-effect-'));
const failures = [];
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (maxBrightness <= 0.04) failures.push(`maxBrightness=${maxBrightness.toFixed(4)} <= 0.04`);
if (falsify === 'force-debug-color' && (tight[0] ?? 0) < 200) {
  failures.push(`FALSIFY debug shader did not reach the output: firstPixel=${tight[0] ?? 0}`);
}
if (falsify === '' && fogCloseCount < 10000) {
  failures.push(`fog color did not materially affect the frame: fogClosePixels=${fogCloseCount} < 10000`);
}
if (falsify === 'force-no-fog' && !hasPostEffect) failures.push(`FALSIFY removed the required fog pass: ${JSON.stringify(passNames)}`);
if (falsify !== 'force-no-fog' && !hasPostEffect) failures.push(`fog post-effect missing: ${JSON.stringify(passNames)}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
console.log(`[smoke] backend=${app.renderer.backend}`);
console.log(`[smoke] frames=${frames} passNames=${JSON.stringify(passNames)}`);
console.log(`[smoke] maxBrightness=${maxBrightness.toFixed(4)} fogClosePixels=${fogCloseCount} png=${pngOut}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - fog scene rendered with depth post-process and zero engine errors');
process.exit(0);
