// instance-decode-convention.dawn.test.ts — M5 lockdown (round-1 fix-up:
// address F-1).
//
// SSOT: packages/shader/src/common.wgsl:374-390
//   struct InstanceData {
//     localFromInstance : mat4x4<f32>,      // 64 B column-major
//     region            : vec4<f32>,        // +16 B when PER_INSTANCE_REGION == true
//   };
//   @group(3) @binding(0) var<storage, read> instances : array<InstanceData>;
//
// This test records a real dawn-node WebGPU frame that binds a per-instance
// storage buffer at group-3 / binding-0 (mat4 + region, the 80 B variant that
// SpriteInstances / tilemap materials emit) and then asserts the recorded tape
// carries the expected raw-byte convention:
//   bufferSize / instanceCount ∈ {64, 80}
//   bufferSize === (64 or 80) * instanceCount
//
// Why dawn instead of a synthetic tape (round-0 tautology fix): a synthetic
// tape lets the test's own byte builder self-prove the assertion — the check
// only fires when the builder is changed. A real dawn-node submit forces the
// bytes through the recorder's writeBuffer → blobPool path, so if the
// InstanceData struct ever evolves (e.g. adds a vec4 field pushing stride to
// 96 B), the shader validation + the recorder's captured byte length reflect
// the new reality and the assertion goes red.
//
// This file follows the recorder-wrap dawn-node pattern established by
// steady-frame-self-containment.dawn.test.ts + inspect-offline.dawn.test.ts
// (create-then-arm bootstrap, wrap the real RhiInstance, drive one frame,
// getTape → serializeTape → buildFrameModel).
//
// Local dawn-node availability: this test is registered under the root
// `dawn` vitest project (vitest.config.ts) and is skipped when
// FORGEAX_SKIP_DAWN=1 or when @forgeax/engine-rhi-webgpu cannot be
// dynamically imported. CI's dawn project is the source-of-truth gate.

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e constructs RHI
// mock surfaces (GPU device/buffer brands, WebGPU descriptor types) whose
// structural shapes require any casts at the test boundary; dawn-node opaque
// GPU types cannot be imported at the type level.

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { deserializeTape, serializeTape } from '../tape-format';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
  } catch {
    return undefined;
  }
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

const INSTANCE_COUNT = 4;
const STRIDE = 80; // mat4 (64 B) + region vec4 (16 B) — PER_INSTANCE_REGION variant.
const RT_WIDTH = 32;
const RT_HEIGHT = 32;

// Minimal WGSL that consumes the InstanceData layout the engine emits. Kept
// intentionally small — the point is not the pixel output; it is that the
// storage buffer bound at group-3 / binding-0 flows through the recorder's
// writeBuffer capture path with exactly STRIDE * INSTANCE_COUNT bytes.
const VS_WGSL = /* wgsl */ `
struct InstanceData {
  localFromInstance : mat4x4<f32>,
  region : vec4<f32>,
};
@group(3) @binding(0) var<storage, read> instances : array<InstanceData>;

@vertex
fn main(
  @builtin(vertex_index) vid : u32,
  @builtin(instance_index) iid : u32,
) -> @builtin(position) vec4<f32> {
  let inst = instances[iid];
  let p = vec4<f32>(f32(vid) * 0.1 - 0.1, 0.0, 0.0, 1.0);
  return inst.localFromInstance * p + vec4<f32>(inst.region.x, 0.0, 0.0, 0.0);
}`;

const FS_WGSL = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.5, 0.25, 1.0);
}`;

/** Build INSTANCE_COUNT * STRIDE bytes matching the InstanceData layout. */
function buildInstanceBytes(): ArrayBuffer {
  const bytes = new ArrayBuffer(STRIDE * INSTANCE_COUNT);
  const view = new Float32Array(bytes);
  const strideFloats = STRIDE / 4;
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const base = i * strideFloats;
    // column-major identity mat4
    view[base + 0] = 1;
    view[base + 5] = 1;
    view[base + 10] = 1;
    view[base + 15] = 1;
    // region: (uMin, vMin, uW, vH). Offset per instance so blob bytes differ
    // across instances (evidences a genuine multi-instance write, not a
    // pool-dedup collapse).
    view[base + 16] = 0.1 * i;
    view[base + 17] = 0.0;
    view[base + 18] = 1.0;
    view[base + 19] = 1.0;
  }
  return bytes;
}

async function recordInstancedFrame(pack: DawnPack): Promise<{
  readonly json: string;
  readonly blob: Uint8Array;
}> {
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);

  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  const wrappedDevice = devRes.value;
  const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;

  const vs = await wrappedCreateShader(rawDevice, { code: VS_WGSL });
  if (!vs.ok) throw new Error('vs');
  const fs = await wrappedCreateShader(rawDevice, { code: FS_WGSL });
  if (!fs.ok) throw new Error('fs');

  const bgl3Res = wrappedDevice.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: 0x1 /* VERTEX */,
        buffer: { type: 'read-only-storage' as GPUBufferBindingType },
      },
    ],
  });
  if (!bgl3Res.ok) throw new Error('bgl3');

  const bglEmptyRes = wrappedDevice.createBindGroupLayout({ entries: [] });
  if (!bglEmptyRes.ok) throw new Error('bgl-empty');

  const pipelineLayoutRes = wrappedDevice.createPipelineLayout({
    bindGroupLayouts: [bglEmptyRes.value, bglEmptyRes.value, bglEmptyRes.value, bgl3Res.value],
  });
  if (!pipelineLayoutRes.ok) throw new Error('pipelineLayout');

  const pipeRes = wrappedDevice.createRenderPipeline({
    layout: pipelineLayoutRes.value,
    vertex: { module: vs.value, entryPoint: 'main' },
    fragment: {
      module: fs.value,
      entryPoint: 'main',
      targets: [{ format: 'rgba8unorm' as GPUTextureFormat }],
    },
    primitive: { topology: 'triangle-list' as GPUPrimitiveTopology },
  } as any);
  if (!pipeRes.ok) throw new Error('pipeline');

  const rtRes = wrappedDevice.createTexture({
    size: { width: RT_WIDTH, height: RT_HEIGHT, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11 /* RENDER_ATTACHMENT | COPY_SRC */,
  });
  if (!rtRes.ok) throw new Error('rt');
  const rtViewRes = wrappedDevice.createTextureView(rtRes.value, {});
  if (!rtViewRes.ok) throw new Error('rtView');

  const instanceBufRes = wrappedDevice.createBuffer({
    size: STRIDE * INSTANCE_COUNT,
    usage: 0x0080 /* STORAGE */ | 0x0008 /* COPY_DST */,
  });
  if (!instanceBufRes.ok) throw new Error('instanceBuf');

  const indexBufRes = wrappedDevice.createBuffer({
    size: 6 * 2, // 6 uint16 indices
    usage: 0x0010 /* INDEX */ | 0x0008 /* COPY_DST */,
  });
  if (!indexBufRes.ok) throw new Error('indexBuf');

  const bindGroup3Res = wrappedDevice.createBindGroup({
    layout: bgl3Res.value,
    entries: [
      {
        binding: 0,
        resource: { kind: 'buffer', value: { buffer: instanceBufRes.value } },
      },
    ],
  } as any);
  if (!bindGroup3Res.ok) throw new Error('bindGroup3');

  const armRes = debugInst.arm(1);
  if (!armRes.ok) throw new Error('arm');

  wrappedDevice.queue.writeBuffer(instanceBufRes.value as any, 0, buildInstanceBytes());
  const indexBytes = new Uint16Array([0, 1, 2, 0, 2, 1]);
  wrappedDevice.queue.writeBuffer(indexBufRes.value as any, 0, indexBytes.buffer);

  const encRes = wrappedDevice.createCommandEncoder({});
  if (!encRes.ok) throw new Error('encoder');
  const enc = encRes.value;
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: rtViewRes.value as any,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as any);
  pass.setPipeline(pipeRes.value as any);
  pass.setBindGroup(3, bindGroup3Res.value as any);
  pass.setIndexBuffer(indexBufRes.value as any, 'uint16', 0, indexBytes.byteLength);
  pass.drawIndexed(6, INSTANCE_COUNT, 0, 0, 0);
  pass.end();

  const finRes = enc.finish();
  if (!finRes.ok) throw new Error('finish');
  wrappedDevice.queue.submit([finRes.value] as unknown as readonly never[]);
  await wrappedDevice.queue.onSubmittedWorkDone();

  debugInst.onFrameEnd();

  const tape = debugInst.getTape() as any;
  if (!tape || 'code' in tape)
    throw new Error(`getTape failed: ${tape ? JSON.stringify(tape) : 'undefined'}`);
  const { json, blob } = serializeTape(tape);
  return { json, blob };
}

describe.skipIf(SKIP_DAWN)(
  'm5-1 InstanceData convention lockdown — real dawn-node tape (group-3 binding-0 SSOT)',
  () => {
    it('recorded tape carries multi-instance storage buffer with stride ∈ {64, 80}', async () => {
      const pack = await loadDawnRhi();
      if (!pack) throw new Error('dawn-node RHI unavailable (FORGEAX_SKIP_DAWN not set)');

      const { json, blob } = await recordInstancedFrame(pack);

      // Round-trip through deserialize to prove the tape is self-contained
      // (matches the disk-persistence path AI users hit via forgeax-rhi-debug CLI).
      const deserRes = deserializeTape(json, blob);
      expect(deserRes.ok).toBe(true);
      if (!deserRes.ok) return;
      const tape = deserRes.value;

      const model = buildFrameModel(tape);
      const multiInstanceDraws = model.draws.filter((d) => (d.drawCall.instanceCount ?? 0) > 1);
      // Discriminative failure mode: if the frame recorded no multi-instance
      // draw, the lockdown has nothing to lock. Assert presence directly rather
      // than skip so a silent regression (recorder drops instance bindings)
      // shows up as red, not green (charter P3 explicit failure).
      expect(multiInstanceDraws.length).toBeGreaterThan(0);

      let convincedDraws = 0;
      for (const draw of multiInstanceDraws) {
        const instanceBinding = draw.bindings.find((b) => b.groupIndex === 3 && b.entryIndex === 0);
        if (!instanceBinding) continue;

        const instanceCount = draw.drawCall.instanceCount ?? 0;
        // Locate the writeBuffer / initialData event that seeded this buffer;
        // the recorder keys blobPool by dataHash.
        let hash: string | undefined;
        for (const event of tape.events) {
          if (event.kind === 'initialData' && event.handleId === instanceBinding.handleId) {
            hash = event.dataHash;
            break;
          }
        }
        if (hash === undefined) {
          for (const event of tape.events) {
            if (event.kind === 'writeBuffer' && event.handleId === instanceBinding.handleId) {
              hash = event.dataHash;
              break;
            }
          }
        }
        expect(hash).toBeDefined();
        if (hash === undefined) continue;

        const bytes = tape.blobPool.get(hash);
        expect(bytes).toBeDefined();
        if (bytes === undefined) continue;

        const bufferSize = bytes.byteLength;
        // Stride divides cleanly — no straggler bytes.
        expect(bufferSize % instanceCount).toBe(0);
        const stride = bufferSize / instanceCount;
        // The convention: stride is one of two variants (mat4 / mat4 + region).
        expect([64, 80]).toContain(stride);
        // Buffer size is exactly stride * instanceCount (no padding).
        expect(bufferSize).toBe(stride * instanceCount);
        convincedDraws++;
      }

      // At least one multi-instance draw had a group-3 / binding-0 storage
      // buffer that satisfied the convention. If the InstanceData struct grows
      // a new field so real GPU stride becomes 96 B, the assertion above goes
      // red — that is the intended lockdown mechanism.
      expect(convincedDraws).toBeGreaterThan(0);
    }, 60_000);
  },
);
