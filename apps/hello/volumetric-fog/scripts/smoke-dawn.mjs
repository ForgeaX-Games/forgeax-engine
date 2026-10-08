#!/usr/bin/env node
// hello-volumetric-fog Dawn smoke: exercise the Engine App/Renderer front door.
// The density texture is authored as a real 3D TextureAsset and consumed by
// the VolumetricFog component; no parallel raw compute path is used.

import { execFileSync } from 'node:child_process';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const WIDTH = 200;
const HEIGHT = 150;
const SMOKE_MIN_FRAMES = Number.parseInt(
  process.env.SMOKE_MIN_FRAMES ?? (process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? '24' : '60'),
  10,
);
const jsonMode = process.argv.includes('--json');
const startedAt = Date.now();
const log = (...args) => (jsonMode ? console.error(...args) : console.log(...args));
const artifact = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  backend: 'dawn',
  limits: {},
  errors: [],
  readback: { supported: false, reason: 'GPU probe not attempted' },
  oracle: { name: 'renderer-front-door', status: 'unavailable' },
  pass: false,
  sample: { guid: '019f0000-0000-7000-8000-0000000003f1', generation: 1 },
  memoryBytes: 0,
  recovery: { attempts: 0, status: 'not-needed' },
  timingMs: 0,
};

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (...args) => {
  const adapter = await originalRequestAdapter(...args);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (...deviceArgs) => {
    const device = await originalRequestDevice(...deviceArgs);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        renderTarget?.destroy?.();
        renderTarget = desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) throw new Error('renderer did not configure the fog smoke target');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  VolumetricFog,
  perspective,
} = await import('@forgeax/engine-render');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { Transform } = await import('@forgeax/engine-scene');
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');

const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));

const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
if (!constructed.ok) throw new Error(`volumetric-fog renderer bootstrap failed: ${constructed.error.code}`);
const { renderer } = constructed.value;
artifact.limits = renderer.inspect().capabilities;
const world = new World();
const densityData = new Uint8Array(2 * 2 * 2);
for (let index = 0; index < densityData.length; index += 1) densityData[index] = index + 1;
const density = world.allocSharedRef('TextureAsset', {
  kind: 'texture',
  shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
  format: 'r8unorm',
  data: densityData,
  colorSpace: 'linear',
  mips: { kind: 'none' },
});
const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.25, 0.42, 0.8, 1]));
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [material] } },
);
const light = world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.7, -0.5], color: [1, 1, 1], intensity: 1 },
}).unwrap();
world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0 } }).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT }), clearColor: [0, 0, 0, 1] } },
);
world.spawn({
  component: VolumetricFog,
  data: {
    light,
    density,
    boundsMin: [-2, -2, -2],
    boundsMax: [2, 2, 2],
    extinction: [0.01, 0.01, 0.01],
    albedo: [1, 1, 1],
    emission: [0, 0, 0],
    anisotropy: 0,
    maxDistance: 20,
  },
}).unwrap();

const attachment = renderer.attach(world);
if (!attachment.ok) throw new Error(`volumetric-fog renderer attach failed: ${attachment.error.code}`);
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, detail: event.error.detail });
});
log(`[hello-volumetric-fog] backend=${renderer.inspect().capabilities.backendKind}`);
let framesObserved = 0;
let latestReceipt;
for (; framesObserved < SMOKE_MIN_FRAMES; framesObserved += 1) {
  world.update().unwrap();
  const drawn = renderer.draw({
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  });
  if (!drawn.ok) throw new Error(`volumetric-fog draw failed at frame ${framesObserved + 1}: ${drawn.error.code}`);
  latestReceipt = drawn.value;
}
if (!sharedDevice || !renderTarget) throw new Error('volumetric-fog renderer did not produce a readback target');
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
const pixels = new Uint8Array(readback.getMappedRange().slice());
readback.unmap();
readback.destroy();
const nonBlackPixels = pixels.reduce((count, value, index) => {
  if (index % 4 !== 0) return count;
  return count + ((value ?? 0) | (pixels[index + 1] ?? 0) | (pixels[index + 2] ?? 0) ? 1 : 0);
}, 0);
const inspection = await renderer.observe(latestReceipt, { include: ['draws', 'bindings'] });
if (!inspection.ok) throw new Error(`volumetric-fog inspection failed: ${inspection.error.code}`);
artifact.readback = { supported: true, nonBlackPixels };
artifact.framesObserved = framesObserved;
artifact.memoryBytes = bytesPerRow * HEIGHT;
artifact.oracle = { name: 'renderer-front-door', status: nonBlackPixels > 0 ? 'pass' : 'mismatch' };
artifact.pass = nonBlackPixels > 0 && errors.length === 0;
artifact.timingMs = Date.now() - startedAt;
log(`[smoke] frames observed=${framesObserved}`);
log(`[smoke] readback=${JSON.stringify({ nonBlackPixels, inspection: inspection.value })}`);
if (framesObserved < SMOKE_MIN_FRAMES) throw new Error(`frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (nonBlackPixels === 0) throw new Error('volumetric-fog readback was entirely black');
if (errors.length > 0) throw new Error(`volumetric-fog renderer errors: ${JSON.stringify(errors)}`);
if (!jsonMode) emitSmokeReceipt('hello-volumetric-fog/smoke', framesObserved);
log(
  `[smoke] PASS - Engine App/Renderer front door, 3D density, ${SMOKE_MIN_FRAMES} frames, readback and inspection GREEN`,
);
if (jsonMode) console.log(JSON.stringify(artifact));
sharedDevice.destroy?.();
process.exit(0);
