#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { create, globals } from 'webgpu';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = resolve(APP_ROOT, 'assets', 'pulse-material.pack.json');
const FRAME_COUNT = 300;

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

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

async function assertRuntimeReadiness(fixture) {
  const cookedByGuid = new Map(
    fixture.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
  );
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
  assert(root.status === 'Ready' && derived.status === 'Ready', 'runtime cooked records are not ready');
  assert(root.artifact.digest === derived.artifact.digest, 'root and derived cooked artifacts differ');
  assert(root.record.receipt.inputDigest === derived.record.receipt.inputDigest, 'specialization inputs differ');
  assert(
    JSON.stringify(stableJson(root.record.resolved.values)) === JSON.stringify(stableJson(derived.record.resolved.values)),
    'runtime-resolved material values differ',
  );
  return { root, derived };
}

const fixture = readFixture();
const parity = await assertRuntimeReadiness(fixture);
Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
assert(adapter !== null, 'Dawn did not provide a WebGPU adapter');
const device = await adapter.requestDevice();
const texture = device.createTexture({
  size: { width: 1, height: 1 },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const readback = device.createBuffer({
  size: 256,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.95, g: 0.45, b: 0.2, a: 1 },
      },
    ],
  });
  pass.end();
  if (frame === FRAME_COUNT - 1) {
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
  }
  device.queue.submit([encoder.finish()]);
}
await device.queue.onSubmittedWorkDone();
await readback.mapAsync(GPUMapMode.READ);
const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
readback.unmap();
assert(
  pixel[0] >= 240 && pixel[1] >= 110 && pixel[2] >= 45 && pixel[3] === 255,
  `Dawn readback did not preserve the expected material color: ${pixel.join(',')}`,
);
readback.destroy();
texture.destroy();
device.destroy();
console.log(
  JSON.stringify({
    status: 'pass',
    frames: FRAME_COUNT,
    backend: 'dawn-webgpu',
    pixel,
    rootArtifactDigest: parity.root.artifact.digest,
    derivedArtifactDigest: parity.derived.artifact.digest,
    values: parity.root.record.resolved.values,
  }),
);
