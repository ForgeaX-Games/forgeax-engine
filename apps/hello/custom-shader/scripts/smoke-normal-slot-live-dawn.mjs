#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 200;
const HEIGHT = 150;
const RESIZED_WIDTH = 256;
const RESIZED_HEIGHT = 192;
const BYTES_PER_PIXEL = 4;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = resolve(APP_ROOT, 'assets', 'pulse-material.pack.json');
const MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
const ARTIFACT_DIR = process.env.FORGEAX_MATERIAL_ARTIFACT_DIR;
if (ARTIFACT_DIR !== undefined) mkdirSync(ARTIFACT_DIR, { recursive: true });
const require = createRequire(resolve(APP_ROOT, 'package.json'));
const { PNG } = require('pngjs');
const resizeVariant = process.env.FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT;
const twoSlotResizeVariant = process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT;
const twoSlotResizeRebuild = twoSlotResizeVariant === 'normal' || twoSlotResizeVariant === 'swap';
const twoSlotSwap = twoSlotResizeVariant === 'swap';
const inheritanceLive = process.env.FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND === '1';
const inheritanceFalsify = process.env.FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND === '1';
const resizeRebuild = twoSlotResizeRebuild || resizeVariant === 'normal' || resizeVariant === 'swap';
const liveSwap = twoSlotSwap || resizeVariant === 'swap' || (!resizeRebuild && twoSlotResizeVariant === undefined);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

function materialFromRecord(record, baseColorHandle, normalHandle) {
  return {
    kind: 'material',
    passes: [...record.resolved.passes],
    parameters: record.resolved.parameters,
    values: {
      ...record.resolved.values,
      baseColorTexture: {
        texture: baseColorHandle,
        coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1] } },
      },
      normalTexture: {
        texture: normalHandle,
        coordinates: { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 2] } },
      },
    },
  };
}

function bytesPerRow(width) {
  return Math.ceil((width * BYTES_PER_PIXEL) / 256) * 256;
}

function compactReadback(bytes, width, height) {
  const packed = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  const rowBytes = bytesPerRow(width);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * rowBytes;
    const targetStart = y * width * BYTES_PER_PIXEL;
    Buffer.from(bytes).copy(packed, targetStart, sourceStart, sourceStart + width * BYTES_PER_PIXEL);
  }
  return packed;
}

function writePng(path, rgba, width, height) {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

function compareRgba(before, after, width, height) {
  assert(before.length === after.length, 'Dawn readbacks must have matching dimensions');
  let changedPixels = 0;
  let absoluteRgbDelta = 0;
  for (let index = 0; index < before.length; index += 4) {
    const redDelta = Math.abs(before[index] - after[index]);
    const greenDelta = Math.abs(before[index + 1] - after[index + 1]);
    const blueDelta = Math.abs(before[index + 2] - after[index + 2]);
    if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels += 1;
    absoluteRgbDelta += redDelta + greenDelta + blueDelta;
  }
  return {
    changedPixels,
    changedFraction: changedPixels / (width * height),
    meanRgbDelta: absoluteRgbDelta / (width * height * 3 * 255),
  };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const cookedByGuid = new Map(
  fixture.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
);
const { createMaterialLoader } = await import('@forgeax/engine-assets-runtime');
const loader = createMaterialLoader({
  loadRecord: async (guid) => cookedByGuid.get(guid.toLowerCase()),
  loadReference: async () => true,
});
const root = await loader.load({
  guid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
  specializationKey: 'my-game::pulse-material',
});
const derived = await loader.load({
  guid: '01935b00-7d8c-7c4e-9f12-345678abcd03',
  specializationKey: 'my-game::pulse-material',
});
assert(root.status === 'Ready' && derived.status === 'Ready', 'inheritance material records are not runtime-ready');
assert(root.artifact.digest === derived.artifact.digest, 'root and derived cooked artifacts differ');
assert(root.record.receipt.inputDigest === derived.record.receipt.inputDigest, 'inheritance specialization inputs differ');
assert(
  JSON.stringify(stableJson(root.record.resolved.values)) === JSON.stringify(stableJson(derived.record.resolved.values)),
  'inheritance runtime-resolved material values differ',
);

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
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
let renderTargetWidth = 0;
let renderTargetHeight = 0;
function ensureRenderTarget(device, format) {
  if (renderTarget !== undefined && (renderTargetWidth !== mockCanvas.width || renderTargetHeight !== mockCanvas.height)) {
    renderTarget.destroy();
    renderTarget = undefined;
  }
  renderTarget ??= device.createTexture({
    size: { width: mockCanvas.width, height: mockCanvas.height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTargetWidth = mockCanvas.width;
  renderTargetHeight = mockCanvas.height;
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        assert(sharedDevice !== undefined, 'engine requested canvas texture before Dawn device capture');
        return ensureRenderTarget(sharedDevice, 'rgba8unorm');
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } =
  await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const manifest = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
const renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: manifest });
const ready = await renderer.ready;
assert(ready.ok, `renderer.ready failed: ${ready.ok ? '' : ready.error.code}`);
assert(renderer.backend === 'webgpu', `unexpected backend: ${renderer.backend}`);

const world = new World();
const baseColorTexturePayload = {
  kind: 'texture', width: 2, height: 2, format: 'rgba8unorm-srgb',
  data: new Uint8Array([255, 96, 32, 255, 32, 96, 255, 255, 32, 96, 255, 255, 255, 96, 32, 255]),
  colorSpace: 'srgb', mipmap: false,
};
const normalTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([32, 224, 32, 255, 224, 32, 32, 255, 224, 32, 32, 255, 32, 224, 32, 255]),
};
const liveSwapBaseColorTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([32, 224, 224, 255, 224, 224, 32, 255, 224, 224, 32, 255, 32, 224, 224, 255]),
};
const liveSwapNormalTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([224, 32, 224, 255, 32, 32, 224, 255, 32, 32, 224, 255, 224, 32, 224, 255]),
};
const baseColorHandle = world.allocSharedRef('TextureAsset', baseColorTexturePayload);
const normalHandle = world.allocSharedRef('TextureAsset', normalTexturePayload);
const liveSwapBaseColorHandle = world.allocSharedRef('TextureAsset', liveSwapBaseColorTexturePayload);
const liveSwapNormalHandle = world.allocSharedRef('TextureAsset', liveSwapNormalTexturePayload);
for (const [label, handle, payload] of [
  ['base-color', baseColorHandle, baseColorTexturePayload],
  ['normal', normalHandle, normalTexturePayload],
  ['live-swap-base-color', liveSwapBaseColorHandle, liveSwapBaseColorTexturePayload],
  ['live-swap-normal', liveSwapNormalHandle, liveSwapNormalTexturePayload],
]) {
  const upload = await renderer.store.uploadTexture(handle, payload, {
    bytes: payload.data,
    width: payload.width,
    height: payload.height,
    mime: 'image/png',
    colorSpace: payload.colorSpace,
    mipmap: payload.mipmap,
  });
  assert(upload.ok, `${label} texture upload failed`);
}

const normalMaterial = materialFromRecord(derived.record, baseColorHandle, normalHandle);
const swapMaterial = materialFromRecord(
  derived.record,
  inheritanceLive
    ? inheritanceFalsify
      ? baseColorHandle
      : liveSwapBaseColorHandle
    : twoSlotSwap
      ? liveSwapBaseColorHandle
      : baseColorHandle,
  inheritanceLive
    ? inheritanceFalsify
      ? normalHandle
      : liveSwapNormalHandle
    : liveSwap
      ? liveSwapNormalHandle
      : normalHandle,
);
const normalMaterialHandle = world.allocSharedRef('MaterialAsset', normalMaterial);
const swapMaterialHandle = world.allocSharedRef('MaterialAsset', swapMaterial);
const box = createBoxGeometry(1, 1, 1);
assert(box.ok, 'box geometry creation failed');
const boxHandle = world.allocSharedRef('MeshAsset', box.value);
world.spawn(
  { component: Transform, data: { pos: [-0.9, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: boxHandle } },
  { component: MeshRenderer, data: { materials: [normalMaterialHandle] } },
).unwrap();
const entity = world.spawn(
  { component: Transform, data: { pos: [0.9, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: boxHandle } },
  { component: MeshRenderer, data: { materials: [normalMaterialHandle] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 0.95, 0.9], intensity: 1 },
}).unwrap();

const materialValues = normalMaterial.values;
if (materialValues !== undefined) materialValues.time = 0;
const errors = [];
renderer.onError((error) => errors.push(error.code));

async function readback(label) {
  const width = mockCanvas.width;
  const height = mockCanvas.height;
  const rowBytes = bytesPerRow(width);
  const buffer = sharedDevice.createBuffer({ size: rowBytes * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow: rowBytes, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await sharedDevice.queue.onSubmittedWorkDone();
  await buffer.mapAsync(0x01);
  const rgba = compactReadback(buffer.getMappedRange(), width, height);
  buffer.unmap();
  buffer.destroy();
  const result = {
    label,
    sha256: createHash('sha256').update(rgba).digest('hex'),
    width,
    height,
    centerPixel: [...rgba.subarray(((height >> 1) * width + (width >> 1)) * 4, ((height >> 1) * width + (width >> 1)) * 4 + 4)],
  };
  if (ARTIFACT_DIR !== undefined) {
    writePng(resolve(ARTIFACT_DIR, `live-normal-slot-${label}.png`), rgba, width, height);
    writeFileSync(resolve(ARTIFACT_DIR, `live-normal-slot-${label}.rgba`), rgba);
    writeFileSync(
      resolve(ARTIFACT_DIR, `live-normal-slot-${label}.json`),
      `${JSON.stringify({ width, height, byteLength: rgba.length, sha256: result.sha256 })}\n`,
    );
  }
  return { ...result, rgba };
}

async function drawFrame(label) {
  const result = renderer.draw([world], { owner: 0 });
  assert(result.ok, `${label} draw failed: ${result.ok ? '' : result.error.code}`);
  await sharedDevice.queue.onSubmittedWorkDone();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Custom material PSOs are built through the renderer's lazy runtime cache.
// Warm the public draw path before taking the baseline so the evidence tests
// the live resource rebind rather than the first-frame pipeline compile.
for (let frame = 0; frame < 4; frame += 1) await drawFrame(`warmup-${frame}`);
const before = await readback('before');
const mutation = liveSwap ? world.set(entity, MeshRenderer, { materials: [swapMaterialHandle] }) : { ok: true };
assert(mutation.ok, `live material rebind failed: ${mutation.ok ? '' : mutation.error.code}`);
for (let frame = 0; frame < 4; frame += 1) await drawFrame(`pre-resize-${frame}`);
const beforeResize = await readback('before-resize');
if (resizeRebuild) {
  mockCanvas.width = RESIZED_WIDTH;
  mockCanvas.height = RESIZED_HEIGHT;
  for (let frame = 0; frame < 4; frame += 1) await drawFrame(`post-resize-${frame}`);
}
const after = await readback(resizeRebuild ? 'after-resize' : 'after');
const delta = resizeRebuild ? undefined : compareRgba(before.rgba, after.rgba, WIDTH, HEIGHT);
assert(!resizeRebuild || (after.width === RESIZED_WIDTH && after.height === RESIZED_HEIGHT), 'Dawn resize did not reach the requested drawing buffer');
if (delta !== undefined) {
  if (inheritanceFalsify) {
    assert(delta.changedPixels === 0 && delta.meanRgbDelta === 0, `inheritance falsifier unexpectedly changed rendered pixels: ${JSON.stringify(delta)}`);
  } else {
    assert(delta.changedPixels > 0 && delta.meanRgbDelta > 0.001, `normal-slot live rebind was not visually discriminative: ${JSON.stringify(delta)}`);
  }
}
assert(errors.length === 0, `renderer errors: ${errors.join(',')}`);

const afterBaseColorHandle = inheritanceLive
  ? inheritanceFalsify
    ? baseColorHandle
    : liveSwapBaseColorHandle
  : twoSlotSwap
    ? liveSwapBaseColorHandle
    : baseColorHandle;
const afterNormalHandle = inheritanceLive
  ? inheritanceFalsify
    ? normalHandle
    : liveSwapNormalHandle
  : liveSwap
    ? liveSwapNormalHandle
    : normalHandle;
if (inheritanceFalsify) {
  assert(afterBaseColorHandle === baseColorHandle && afterNormalHandle === normalHandle, 'inheritance falsifier unexpectedly changed replacement texture handles');
  throw new Error('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind');
}

const output = {
  status: 'pass',
  frontDoor: 'engine-renderer-world-draw',
  backend: renderer.backend,
  frames: { before: 1, after: 1 },
  material: {
    beforeHandle: normalMaterialHandle,
    afterHandle: liveSwap ? swapMaterialHandle : normalMaterialHandle,
    beforeTextureHandles: [baseColorHandle, normalHandle],
    afterTextureHandles: [afterBaseColorHandle, afterNormalHandle],
    baseColorPreserved: inheritanceLive ? inheritanceFalsify : !twoSlotSwap,
    baseColorChanged: inheritanceLive ? !inheritanceFalsify : twoSlotSwap,
    normalSlotChanged: inheritanceLive ? !inheritanceFalsify : liveSwap,
    twoSlotSwap,
    inheritanceBacked: inheritanceLive,
    sourceDerivedGuid: derived.record.guid,
    sourceArtifactDigest: derived.artifact.digest,
    sourceCookInputDigest: derived.record.receipt.inputDigest,
  },
  before: { sha256: before.sha256, centerPixel: before.centerPixel },
  beforeResize: { sha256: beforeResize.sha256, centerPixel: beforeResize.centerPixel },
  after: { sha256: after.sha256, centerPixel: after.centerPixel, width: after.width, height: after.height },
  resize: { enabled: resizeRebuild, before: [WIDTH, HEIGHT], after: [after.width, after.height] },
  delta,
  rootArtifactDigest: root.artifact.digest,
  derivedArtifactDigest: derived.artifact.digest,
  rootCookInputDigest: root.record.receipt.inputDigest,
  derivedCookInputDigest: derived.record.receipt.inputDigest,
};
console.log(JSON.stringify(output));
sharedDevice.destroy();
