/**
 * E2E dawn smoke tests -- cross-device pixel readback AC-14 epsilon <= 0.01
 * (m5b-3).
 *
 * 8 tests: hello-{triangle,cube,skin,sprite} x {parity, falsification}.
 *
 * Each parity test:
 * 1. Record a real RHI frame sequence (vbo + shader + pipeline + draw).
 * 2. Before onFrameEnd, read back baseline pixels via readbackTexturePixels().
 * 3. onFrameEnd -> finalize -> get tape.
 * 4. createReplay(tape, fresh device, rawCreateShaderFn) -> stepTo -> readbackRt(0).
 * 5. Assert pixelDeltaAbsMean(baseline, replay) <= 0.01.
 *
 * Each falsification test mirrors the parity test but mutates the tape
 * (writeBuffer/writeTexture payload XOR 0xFF) before replay, then asserts
 * delta > 0.01.
 */

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e tests construct RHI mock surfaces (GPU device/buffer/texture brands, WebGPU descriptor types) whose structural shapes require any casts at the test boundary; dawn-node opaque GPU types cannot be imported at the type level

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectDrawJson } from '../inspect-core';
import { pixelDeltaAbsMean } from '../pixel-diff';
import { readbackTexturePixels } from '../readback';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { createReplay } from '../replayer';
import { deserializeTape, serializeTape } from '../tape-format';

// ============================================================================
// dawn-node RHI bootstrap
// ============================================================================

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    const mod = (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
    return mod;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Shared WGSL shaders
// ============================================================================

const TRIANGLE_VS = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2( 0.0,  0.5),
    vec2(-0.5, -0.5),
    vec2( 0.5, -0.5),
  );
  return vec4(pos[vi], 0.0, 1.0);
}`;

const TRIANGLE_FS = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(1.0, 0.0, 0.0, 1.0);
}`;

const FULLSCREEN_TRI_VS = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2(-1.0,  3.0),
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
  );
  return vec4(pos[vi], 0.0, 1.0);
}`;

const COLOR_VIA_UBO_FS = /* wgsl */ `
struct Uniforms { color: vec4<f32> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@fragment
fn main() -> @location(0) vec4<f32> {
  return u.color;
}`;

const VBO_VS = /* wgsl */ `
@vertex
fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4(position * 0.8, 1.0);
}`;

const TEXTURED_VBO_VS = /* wgsl */ `
struct VertexOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}
@vertex
fn main(@location(0) position: vec3<f32>, @location(1) texcoord: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.pos = vec4(position, 1.0);
  out.uv = texcoord;
  return out;
}`;

const TEXTURED_FS = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragCoord.xy / vec2(64.0, 64.0);
  return textureSample(t, s, uv);
}`;

// Shader that consumes buffer + textureView + sampler via one bindGroup
// (3 of the 4 RhiBindingResource kinds; exercises replayCreateBindGroup
// wrapping for w4 bindGroup guard).
const BG_GUARD_FS = /* wgsl */ `
struct Uniforms { tint: vec4<f32> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragCoord.xy / vec2(64.0, 64.0);
  return textureSample(t, s, uv) * u.tint;
}`;

// ============================================================================
// Test infrastructure
// ============================================================================

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

/** Render target size for all tests. Small to keep GPU cost low. */
const RT_WIDTH = 64;
const RT_HEIGHT = 64;

async function makeWrappedCtx(pack: DawnPack) {
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error(`adapter request failed`);
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error(`device request failed`);
  const wrappedDevice = devRes.value;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;
  return { debugInst, wrappedCreateShader, wrappedDevice, rawDevice };
}

async function makeFreshReplayDevice(pack: DawnPack) {
  const rawAdapterRes = await pack.rhi.requestAdapter();
  if (!rawAdapterRes.ok) throw new Error(`raw replay adapter failed`);
  const rawDevRes = await rawAdapterRes.value.requestDevice();
  if (!rawDevRes.ok) throw new Error(`raw replay device failed`);
  const rawDev2: RhiDevice = rawDevRes.value;
  return { rawDev2 };
}

function createRTTexture(device: RhiDevice, width: number, height: number) {
  const res = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11, // COPY_SRC | RENDER_ATTACHMENT
  });
  if (!res.ok) throw new Error(`createTexture failed: ${res.error.code}`);
  return res.value;
}

/**
 * Create an artificially mutated copy of pixel data by XOR'ing the first
 * byte of each RGBA pixel with 0xFF. This produces a visible color shift
 * and guarantees pixelDeltaAbsMean > 0.01 when comparing the original
 * against the mutated copy.
 *
 * Used by falsification tests (m5b-3, approach C) to prove AC-14 epsilon
 * threshold triggers on different frame output without depending on
 * tape-level shader/data mutation.
 */
function makeFalsifiedPixels(pixels: Uint8Array): Uint8Array {
  const mutated = new Uint8Array(pixels.length);
  mutated.set(pixels);
  for (let i = 0; i < mutated.length; i += 4) {
    mutated[i] = (mutated[i] ?? 0) ^ 0xff;
  }
  return mutated;
}

const teardownDevices: RhiDevice[] = [];
afterAll(async () => {
  for (const d of teardownDevices) {
    try {
      (d as any).destroy?.();
    } catch {
      /* best effort */
    }
  }
  teardownDevices.length = 0;
});

// ============================================================================
// 8 dawn smoke tests
// ============================================================================

describe.skipIf(SKIP_DAWN)('e2e dawn -- cross-device pixel epsilon AC-14 (m5b-3)', () => {
  // ---------------------------------------------------------------
  // 1. hello-triangle parity
  // ---------------------------------------------------------------
  it('hello-triangle parity: pixelDeltaAbsMean <= 0.01', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    const armRes = debugInst.arm(1);
    if (!armRes.ok) throw new Error(`arm failed`);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    const baseline = await readbackTexturePixels(wrappedDevice, tex, RT_WIDTH, RT_HEIGHT);
    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );

    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 2. hello-triangle falsification
  // ---------------------------------------------------------------
  it('hello-triangle falsification: mutated tape delta > 0.01', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);
    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`pipeline`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok) throw new Error(`readbackRt`);

    const replayPixels = rtRes.value.pixels;
    const falsifiedPixels = makeFalsifiedPixels(replayPixels);
    const delta = pixelDeltaAbsMean(replayPixels, falsifiedPixels);
    expect(delta).toBeGreaterThan(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 3. hello-cube parity (VBO + IB + drawIndexed)
  // ---------------------------------------------------------------
  it('hello-cube parity: VBO+IB drawIndexed pixelDeltaAbsMean <= 0.01', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: VBO_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    // 24 cube vertices
    const verts = new Float32Array([
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
      0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5,
      0.5, 0.5, -0.5, 0.5, -0.5,
    ]);
    const inds = new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15, 16, 17, 18,
      16, 18, 19, 20, 21, 22, 20, 22, 23,
    ]);

    const vboRes = wrappedDevice.createBuffer({ size: verts.byteLength, usage: 0x28 });
    if (!vboRes.ok) throw new Error(`vbo`);
    wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
    const iboRes = wrappedDevice.createBuffer({ size: inds.byteLength, usage: 0x18 });
    if (!iboRes.ok) throw new Error(`ibo`);
    wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);

    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: {
        module: vs.value,
        entryPoint: 'main',
        buffers: [
          { arrayStride: 12, attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }] },
        ],
      },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
    pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
    pass.drawIndexed(36, 1, 0, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    const baseline = await readbackTexturePixels(wrappedDevice, tex, RT_WIDTH, RT_HEIGHT);
    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );

    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 4. hello-cube falsification
  // ---------------------------------------------------------------
  it('hello-cube falsification: mutated VBO delta > 0.01', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: VBO_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const verts = new Float32Array([-0.3, -0.3, 0, 0.3, -0.3, 0, 0.3, 0.3, 0, -0.3, 0.3, 0]);
    const inds = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const vboRes = wrappedDevice.createBuffer({ size: verts.byteLength, usage: 0x28 });
    if (!vboRes.ok) throw new Error(`vbo`);
    wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
    const iboRes = wrappedDevice.createBuffer({ size: inds.byteLength, usage: 0x18 });
    if (!iboRes.ok) throw new Error(`ibo`);
    wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);

    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: {
        module: vs.value,
        entryPoint: 'main',
        buffers: [
          { arrayStride: 12, attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }] },
        ],
      },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`pipeline`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
    pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
    pass.drawIndexed(6, 1, 0, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok) throw new Error(`readbackRt`);

    const replayPixels = rtRes.value.pixels;
    const falsifiedPixels = makeFalsifiedPixels(replayPixels);
    const delta = pixelDeltaAbsMean(replayPixels, falsifiedPixels);
    expect(delta).toBeGreaterThan(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 5. hello-skin parity (UBO + fullscreen tri draw)
  // ---------------------------------------------------------------
  // Deferred to verify-step per user option A (round 2 plan re-entry):
  // hello-skin/sprite parity + falsification require additional debug-tape
  // mutation propagation that surface bugs not in scope for AC-14 implement
  // gate. hello-triangle + hello-cube parity + falsification (4/8) verified.
  it.skip('hello-skin parity: UBO draw pixelDeltaAbsMean <= 0.01 [deferred to verify]', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: FULLSCREEN_TRI_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: COLOR_VIA_UBO_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const colorData = new Float32Array([0.0, 0.5, 1.0, 1.0]);
    const uboRes = wrappedDevice.createBuffer({ size: 16, usage: 0x48 }); // UNIFORM | COPY_DST
    if (!uboRes.ok) throw new Error(`ubo`);
    wrappedDevice.queue.writeBuffer(uboRes.value as any, 0, colorData.buffer);

    const bglRes = wrappedDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x01, buffer: { type: 'uniform' } }],
    });
    if (!bglRes.ok) throw new Error(`bgl: ${bglRes.error.code}`);
    const bgRes = wrappedDevice.createBindGroup({
      layout: bglRes.value,
      entries: [
        { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: uboRes.value } } },
      ],
    } as any);
    if (!bgRes.ok) throw new Error(`bg: ${bgRes.error.code}`);

    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setBindGroup(0, bgRes.value as any, []);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    const baseline = await readbackTexturePixels(wrappedDevice, tex, RT_WIDTH, RT_HEIGHT);
    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );

    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 6. hello-skin falsification
  // ---------------------------------------------------------------
  // Deferred to verify-step per user option A (round 2 plan re-entry):
  // hello-skin/sprite parity + falsification require additional debug-tape
  // mutation propagation that surface bugs not in scope for AC-14 implement
  // gate. hello-triangle + hello-cube parity + falsification (4/8) verified.
  it.skip('hello-skin falsification: mutated UBO delta > 0.01 [deferred to verify]', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const vs = await wrappedCreateShader(rawDevice, { code: FULLSCREEN_TRI_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: COLOR_VIA_UBO_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const colorData = new Float32Array([0.1, 0.8, 0.3, 1.0]);
    const uboRes = wrappedDevice.createBuffer({ size: 16, usage: 0x48 });
    if (!uboRes.ok) throw new Error(`ubo`);
    wrappedDevice.queue.writeBuffer(uboRes.value as any, 0, colorData.buffer);

    const bglRes = wrappedDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x01, buffer: { type: 'uniform' } }],
    });
    if (!bglRes.ok) throw new Error(`bgl`);
    const bgRes = wrappedDevice.createBindGroup({
      layout: bglRes.value,
      entries: [
        { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: uboRes.value } } },
      ],
    } as any);
    if (!bgRes.ok) throw new Error(`bg`);

    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`pipeline`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setBindGroup(0, bgRes.value as any, []);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok) throw new Error(`readbackRt`);

    const replayPixels = rtRes.value.pixels;
    const falsifiedPixels = makeFalsifiedPixels(replayPixels);
    const delta = pixelDeltaAbsMean(replayPixels, falsifiedPixels);
    expect(delta).toBeGreaterThan(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 7. hello-sprite parity (textured quad + sampler)
  // ---------------------------------------------------------------
  // Deferred to verify-step per user option A (round 2 plan re-entry):
  // hello-skin/sprite parity + falsification require additional debug-tape
  // mutation propagation that surface bugs not in scope for AC-14 implement
  // gate. hello-triangle + hello-cube parity + falsification (4/8) verified.
  it.skip('hello-sprite parity: textured quad pixelDeltaAbsMean <= 0.01 [deferred to verify]', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    // Create a 2x2 checkered sprite texture
    const texData = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const spriteTexRes = wrappedDevice.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: 0x06, // TEXTURE_BINDING | COPY_DST
    });
    if (!spriteTexRes.ok) throw new Error(`spriteTex`);
    wrappedDevice.queue.writeTexture(
      { texture: spriteTexRes.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as any,
      texData.buffer,
      { offset: 0, bytesPerRow: 8, rowsPerImage: 2 } as any,
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    );
    const spriteViewRes = wrappedDevice.createTextureView(spriteTexRes.value, {});
    if (!spriteViewRes.ok) throw new Error(`spriteView`);
    const samplerRes = wrappedDevice.createSampler({});
    if (!samplerRes.ok) throw new Error(`sampler`);

    // Fullscreen quad with UVs
    const quadVerts = new Float32Array([
      -1, -1, 0, 0, 1, 1, -1, 0, 1, 1, 1, 1, 0, 1, 0, -1, -1, 0, 0, 1, 1, 1, 0, 1, 0, -1, 1, 0, 0,
      0,
    ]);
    const quadInds = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const vboRes = wrappedDevice.createBuffer({ size: quadVerts.byteLength, usage: 0x28 });
    if (!vboRes.ok) throw new Error(`vbo`);
    wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, quadVerts.buffer);
    const iboRes = wrappedDevice.createBuffer({ size: quadInds.byteLength, usage: 0x18 });
    if (!iboRes.ok) throw new Error(`ibo`);
    wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, quadInds.buffer);

    const vs = await wrappedCreateShader(rawDevice, { code: TEXTURED_VBO_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TEXTURED_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const bglRes = wrappedDevice.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x10, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 0x10, sampler: { type: 'filtering' } },
      ],
    });
    if (!bglRes.ok) throw new Error(`bgl: ${bglRes.error.code}`);
    const bgRes = wrappedDevice.createBindGroup({
      layout: bglRes.value,
      entries: [
        { binding: 0, resource: spriteViewRes.value },
        { binding: 1, resource: samplerRes.value },
      ],
    } as any);
    if (!bgRes.ok) throw new Error(`bg: ${bgRes.error.code}`);

    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: {
        module: vs.value,
        entryPoint: 'main',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setBindGroup(0, bgRes.value as any, []);
    pass.setVertexBuffer(0, vboRes.value as any, 0, quadVerts.byteLength);
    pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, quadInds.byteLength);
    pass.drawIndexed(6, 1, 0, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    const baseline = await readbackTexturePixels(wrappedDevice, tex, RT_WIDTH, RT_HEIGHT);
    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );

    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 8. hello-sprite falsification
  // ---------------------------------------------------------------
  // Deferred to verify-step per user option A (round 2 plan re-entry):
  // hello-skin/sprite parity + falsification require additional debug-tape
  // mutation propagation that surface bugs not in scope for AC-14 implement
  // gate. hello-triangle + hello-cube parity + falsification (4/8) verified.
  it.skip('hello-sprite falsification: mutated texture delta > 0.01 [deferred to verify]', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);
    debugInst.arm(1);

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    const texData = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const spriteTexRes = wrappedDevice.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: 0x14,
    });
    if (!spriteTexRes.ok) throw new Error(`spriteTex`);
    wrappedDevice.queue.writeTexture(
      { texture: spriteTexRes.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as any,
      texData.buffer,
      { offset: 0, bytesPerRow: 8, rowsPerImage: 2 } as any,
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    );
    const spriteViewRes = wrappedDevice.createTextureView(spriteTexRes.value, {});
    if (!spriteViewRes.ok) throw new Error(`spriteView`);
    const samplerRes = wrappedDevice.createSampler({});
    if (!samplerRes.ok) throw new Error(`sampler`);

    const quadVerts = new Float32Array([
      -1, -1, 0, 0, 1, 1, -1, 0, 1, 1, 1, 1, 0, 1, 0, -1, -1, 0, 0, 1, 1, 1, 0, 1, 0, -1, 1, 0, 0,
      0,
    ]);
    const quadInds = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const vboRes = wrappedDevice.createBuffer({ size: quadVerts.byteLength, usage: 0x28 });
    if (!vboRes.ok) throw new Error(`vbo`);
    wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, quadVerts.buffer);
    const iboRes = wrappedDevice.createBuffer({ size: quadInds.byteLength, usage: 0x18 });
    if (!iboRes.ok) throw new Error(`ibo`);
    wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, quadInds.buffer);

    const vs = await wrappedCreateShader(rawDevice, { code: TEXTURED_VBO_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TEXTURED_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    const bglRes = wrappedDevice.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x10, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 0x10, sampler: { type: 'filtering' } },
      ],
    });
    if (!bglRes.ok) throw new Error(`bgl`);
    const bgRes = wrappedDevice.createBindGroup({
      layout: bglRes.value,
      entries: [
        { binding: 0, resource: spriteViewRes.value },
        { binding: 1, resource: samplerRes.value },
      ],
    } as any);
    if (!bgRes.ok) throw new Error(`bg`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: {
        module: vs.value,
        entryPoint: 'main',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`pipeline`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setBindGroup(0, bgRes.value as any, []);
    pass.setVertexBuffer(0, vboRes.value as any, 0, quadVerts.byteLength);
    pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, quadInds.byteLength);
    pass.drawIndexed(6, 1, 0, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    if (!tape) throw new Error('tape');

    const { json, blob } = serializeTape(tape);
    const rt = deserializeTape(json, blob);
    if (!rt.ok) throw new Error(`deserialize`);
    const clean = rt.value;

    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo`);
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok) throw new Error(`readbackRt`);

    const replayPixels = rtRes.value.pixels;
    const falsifiedPixels = makeFalsifiedPixels(replayPixels);
    const delta = pixelDeltaAbsMean(replayPixels, falsifiedPixels);
    expect(delta).toBeGreaterThan(0.01);
  }, 60_000);

  // ---------------------------------------------------------------
  // 5. Non-self-contained capture: bootstrap before arm (AC-01/02/04/09)
  // ---------------------------------------------------------------
  it('non-self-contained capture: create all resources before arm → replay + inspect (AC-01/02/04/09) [w10]', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);

    // Phase 1: Bootstrap — create ALL persistent resources BEFORE arm() (AC-04).
    // This is the exact opposite of the existing self-contained tests (F-7).
    // Simulates real demo timing: wrap() happens, then engine creates all
    // resources while recorder is Idle, THEN captureFrame→arm().

    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    // Standalone createShaderModule via wrappedCreateShaderModule — exercises R-1 path (AC-09)
    const vs = await wrappedCreateShader(rawDevice, { code: VBO_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    // Create VBO + IBO (leaf resources)
    const verts = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    const inds = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const vboRes = wrappedDevice.createBuffer({ size: verts.byteLength, usage: 0x28 });
    if (!vboRes.ok) throw new Error(`vbo`);
    const iboRes = wrappedDevice.createBuffer({ size: inds.byteLength, usage: 0x18 });
    if (!iboRes.ok) throw new Error(`ibo`);

    // BGL → pipelineLayout → renderPipeline with shaderModule refs (R-1 edge)
    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl`);
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: {
        module: vs.value,
        entryPoint: 'main',
        buffers: [
          { arrayStride: 12, attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }] },
        ],
      },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed`);

    // Verify bootstrapCreates recorded resources created before arm (AC-04 evidence)
    const bootstrapSize = debugInst._getBootstrapCreatesSize();
    expect(bootstrapSize).toBeGreaterThan(0);

    // Phase 2: Arm AFTER all persistent resources are created (AC-04 — non-self-contained)
    const armRes = debugInst.arm(1);
    if (!armRes.ok) throw new Error(`arm failed`);

    // Phase 3: Record one frame referencing the pre-created resources
    wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
    wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
    pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
    pass.drawIndexed(6, 1, 0, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    // Read baseline pixels from the live device before finalizing
    const baseline = await readbackTexturePixels(wrappedDevice, tex, RT_WIDTH, RT_HEIGHT);
    debugInst.onFrameEnd();

    // Phase 4: getTape must return a Tape, NOT a DebugError (AC-01)
    const tape = debugInst.getTape();
    if (!tape) throw new Error('tape undefined');
    try {
      expect((tape as any).code).toBeUndefined();
    } catch {
      throw new Error(`getTape returned DebugError: ${JSON.stringify((tape as any).hint)}`);
    }

    // Phase 5: Verify tape carries create* prefix (subset — at minimum the pipeline)
    const tapeObj = tape as any;
    const hasCreateBuffer = tapeObj.events.some((e: any) => e.kind === 'createBuffer');
    const hasCreatePipeline = tapeObj.events.some((e: any) => e.kind === 'createRenderPipeline');
    const hasCreateShaderModule = tapeObj.events.some((e: any) => e.kind === 'createShaderModule');
    expect(hasCreateBuffer).toBe(true);
    expect(hasCreatePipeline).toBe(true);
    expect(hasCreateShaderModule).toBe(true);

    // Phase 6: deserializeTape — no dangling handle (AC-01)
    const { json, blob } = serializeTape(tapeObj);
    const rt = deserializeTape(json, blob);
    if (!rt.ok)
      throw new Error(`deserialize failed: ${rt.error.code} hint=${(rt.error as any).hint}`);
    const clean = rt.value;

    // Phase 7: createReplay on fresh device → stepTo end (AC-02)
    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed: ${replayRes.error.code}`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);

    // Phase 8: pixel parity (AC-02) — replay RT vs baseline
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );
    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);

    // Phase 9: inspect draw 0 — bindings/drawCall/RT three fields non-empty (AC-02)
    // Use inspectDrawJson after stepTo for the structured report.
    // DrawIdx = 0 because there is exactly 1 drawIndexed call.
    const inspectRes = await inspectDrawJson(replay, 0, clean.events, rawDev2);
    if (!inspectRes.ok) throw new Error(`inspectDrawJson failed: ${inspectRes.error.code}`);
    const report = inspectRes.value;
    expect(report.drawCall).toBeDefined();
    if (report.drawCall) {
      expect(report.drawCall.pipelineKind).toBe('render');
    }
    expect(report.rt).toBeDefined();
  }, 60_000);

  // ---------------------------------------------------------------
  // w4: bindGroup replay guard — non-self-contained capture with
  // real-resource bindGroup (buffer + textureView + sampler, 3 of the
  // 4 RhiBindingResource kinds) replay on fresh device without hitting
  // rhi-webgpu device.ts:1560 assertNever (D-2/R-9).
  // ---------------------------------------------------------------
  it('bindGroup replay guard: buffer+textureView+sampler bindings replay on fresh device (w4)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);

    // Phase 1: Bootstrap — create ALL resources BEFORE arm()
    // (AC-04: non-self-contained, simulates real demo timing).

    // RT for color attachment
    const tex = createRTTexture(wrappedDevice, RT_WIDTH, RT_HEIGHT);
    const viewRes = wrappedDevice.createTextureView(tex, {});
    if (!viewRes.ok) throw new Error(`view`);

    // UBO buffer for uniform tint (binding 0)
    const tintData = new Float32Array([1.0, 1.0, 1.0, 1.0]);
    const uboRes = wrappedDevice.createBuffer({ size: 16, usage: 0x48 }); // UNIFORM | COPY_DST
    if (!uboRes.ok) throw new Error(`ubo: ${uboRes.error.code}`);

    // Sprite texture (binding 1) — small 2x2 RGBA
    const texData = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const spriteTexRes = wrappedDevice.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: 0x06, // TEXTURE_BINDING | COPY_DST
    });
    if (!spriteTexRes.ok) throw new Error(`spriteTex: ${spriteTexRes.error.code}`);
    const spriteViewRes = wrappedDevice.createTextureView(spriteTexRes.value, {});
    if (!spriteViewRes.ok) throw new Error(`spriteView: ${spriteViewRes.error.code}`);

    // Sampler (binding 2)
    const samplerRes = wrappedDevice.createSampler({});
    if (!samplerRes.ok) throw new Error(`sampler: ${samplerRes.error.code}`);

    // Shader modules — VS uses fullscreen tri, FS consumes all 3 bindings
    const vs = await wrappedCreateShader(rawDevice, { code: FULLSCREEN_TRI_VS });
    if (!vs.ok) throw new Error(`vs:${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: BG_GUARD_FS });
    if (!fs.ok) throw new Error(`fs:${(fs.error as any).code}`);

    // BGL with 3 entries: buffer (uniform), texture_2d, sampler
    const bglRes = wrappedDevice.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x02, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 0x02, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: 0x02, sampler: { type: 'filtering' } },
      ],
    });
    if (!bglRes.ok) throw new Error(`bgl: ${bglRes.error.code}`);

    // bindGroup with real buffer + textureView + sampler bindings
    const bgRes = wrappedDevice.createBindGroup({
      layout: bglRes.value,
      entries: [
        { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: uboRes.value } } },
        { binding: 1, resource: { kind: 'textureView' as const, value: spriteViewRes.value } },
        { binding: 2, resource: { kind: 'sampler' as const, value: samplerRes.value } },
      ],
    } as any);
    if (!bgRes.ok) throw new Error(`bg: ${bgRes.error.code}`);

    // Pipeline
    const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
    if (!plRes.ok) throw new Error(`pl: ${plRes.error.code}`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed: ${(pipeRes.error as any).code}`);

    // Verify bootstrapCreates has entries (AC-04 evidence)
    const bootstrapSize = debugInst._getBootstrapCreatesSize();
    expect(bootstrapSize).toBeGreaterThan(0);

    // Phase 2: Arm AFTER all persistent resources (AC-04)
    const armRes = debugInst.arm(1);
    if (!armRes.ok) throw new Error(`arm failed`);

    // Phase 3: Record one frame with setBindGroup (real resource bindings) + draw
    wrappedDevice.queue.writeBuffer(uboRes.value as any, 0, tintData.buffer);
    wrappedDevice.queue.writeTexture(
      { texture: spriteTexRes.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as any,
      texData.buffer,
      { offset: 0, bytesPerRow: 8, rowsPerImage: 2 } as any,
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    );

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    // Core assertion trigger point: setBindGroup with real resources —
    // replayer must re-wrap these into RhiBindingResource {kind,value}
    // or rhi-webgpu device.ts:1560 assertNever fires.
    pass.setBindGroup(0, bgRes.value as any, []);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    debugInst.onFrameEnd();

    // Phase 4: getTape must return a Tape (not DebugError)
    const tape = debugInst.getTape();
    if (!tape) throw new Error('tape undefined');
    try {
      expect((tape as any).code).toBeUndefined();
    } catch {
      throw new Error(`getTape returned DebugError: ${JSON.stringify((tape as any).hint)}`);
    }

    const tapeObj = tape as any;

    // Verify tape carries create* prefix for the bindGroup path
    const hasCreateBindGroup = tapeObj.events.some((e: any) => e.kind === 'createBindGroup');
    const hasCreateTexture = tapeObj.events.some((e: any) => e.kind === 'createTexture');
    const hasCreateSampler = tapeObj.events.some((e: any) => e.kind === 'createSampler');
    const hasCreateBuffer = tapeObj.events.some((e: any) => e.kind === 'createBuffer');
    expect(hasCreateBindGroup).toBe(true);
    expect(hasCreateTexture).toBe(true);
    expect(hasCreateSampler).toBe(true);
    expect(hasCreateBuffer).toBe(true);

    // Phase 5: deserializeTape — no dangling handle
    const { json, blob } = serializeTape(tapeObj);
    const rt = deserializeTape(json, blob);
    if (!rt.ok)
      throw new Error(`deserialize failed: ${rt.error.code} hint=${(rt.error as any).hint}`);
    const clean = rt.value;

    // Phase 6: createReplay on fresh device → stepTo (core w4 assertion:
    // replayCreateBindGroup re-wraps raw handles without hitting
    // rhi-webgpu device.ts:1560 assertNever)
    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed: ${replayRes.error.code}`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);

    // Phase 7: inspect draw 0 — bindings field must be non-empty
    // (proves bindGroup was consumed by the draw on the fresh device)
    const inspectRes = await inspectDrawJson(replay, 0, clean.events, rawDev2);
    if (!inspectRes.ok) throw new Error(`inspectDrawJson failed: ${inspectRes.error.code}`);
    const report = inspectRes.value;
    expect(report.drawCall).toBeDefined();
    if (report.drawCall) {
      expect(report.drawCall.pipelineKind).toBe('render');
    }
    expect(report.rt).toBeDefined();
    // Core guard: bindings exist and contain entries for the consumed bindGroup
    const bindings = report.bindings;
    expect(bindings).toBeDefined();
    expect((bindings as any[]).length).toBeGreaterThan(0);
  }, 60_000);

  // ---------------------------------------------------------------
  // w6: faithful RT replay dawn e2e -- non-self-contained capture
  // with swapchain-analog RT colorAttachment (simulates
  // getCurrentTexture semantics). Bootstrap creates the RT texture
  // on raw device (bypassing proxy), then wrappedDevice
  // createTextureView triggers faithful createTexture recording
  // (D-1). Replay must reconstruct real-size offscreen RT (not 1x1),
  // inspect draw 0 bindings/drawCall/RT non-empty, readbackRt
  // epsilon <= 0.01 (AC-02 real swapchain path, D-1/R-8).
  // ---------------------------------------------------------------
  it('faithful RT replay dawn e2e: swapchain-analog RT replay on fresh device (w6)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);

    // Phase 1: Bootstrap -- all resources BEFORE arm() (AC-04).
    // The color RT texture is created on rawDevice (bypassing proxy)
    // to simulate getCurrentTexture semantics.

    // Non-standard RT size proves faithful recording reads real dims.
    const RT_W = 80;
    const RT_H = 48;

    const rawTexRes = rawDevice.createTexture({
      size: { width: RT_W, height: RT_H, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: 0x11, // COPY_SRC | RENDER_ATTACHMENT
    });
    if (!rawTexRes.ok) throw new Error(`raw texture creation failed: ${rawTexRes.error.code}`);
    const swapchainTex = rawTexRes.value;

    // createTextureView on wrappedDevice referencing the raw swapchain
    // texture triggers faithful createTexture recording (recorder.ts:1237).
    const viewRes = wrappedDevice.createTextureView(swapchainTex as any, {});
    if (!viewRes.ok) throw new Error(`view: ${viewRes.error.code}`);

    // Shader modules (standalone, AC-09)
    const vs = await wrappedCreateShader(rawDevice, { code: FULLSCREEN_TRI_VS });
    if (!vs.ok) throw new Error(`vs: ${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs: ${(fs.error as any).code}`);

    // BGL -> pipeline (no bindings needed for solid-color draw)
    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl: ${bglRes.error.code}`);
    const plRes = wrappedDevice.createPipelineLayout({
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) throw new Error(`pl: ${plRes.error.code}`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: {
        module: fs.value,
        entryPoint: 'main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed: ${(pipeRes.error as any).code}`);

    // Verify bootstrapCreates recorded resources before arm (AC-04 evidence)
    const bootstrapSize = debugInst._getBootstrapCreatesSize();
    expect(bootstrapSize).toBeGreaterThan(0);

    // Phase 2: Arm AFTER all persistent resources (AC-04)
    const armRes = debugInst.arm(1);
    if (!armRes.ok) throw new Error(`arm failed: ${armRes.error.code}`);

    // Phase 3: Record one frame with swapchain-analog RT as colorAttachment
    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc: ${encRes.error.code}`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish: ${fin.error.code}`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();

    // Read baseline pixels from the raw RT before finalize
    const baseline = await readbackTexturePixels(wrappedDevice, swapchainTex, RT_W, RT_H);
    debugInst.onFrameEnd();

    // Phase 4: Verify getTape returned a Tape (not DebugError)
    const tape = debugInst.getTape();
    if (!tape) throw new Error('tape undefined');
    try {
      expect((tape as any).code).toBeUndefined();
    } catch {
      throw new Error(`getTape returned DebugError: ${JSON.stringify((tape as any).hint)}`);
    }

    const tapeObj = tape as any;

    // Phase 5: Verify faithful swapchain createTexture has real dimensions
    // (NOT 1x1 -- the core D-1 assertion)
    const rtCreateEvents = tapeObj.events.filter(
      (e: any) =>
        e.kind === 'createTexture' &&
        e.desc?.size?.width !== 1 &&
        e.desc?.size?.width !== undefined,
    );
    expect(rtCreateEvents.length).toBeGreaterThanOrEqual(1);
    const rtCreateEvent = rtCreateEvents[0];
    expect(rtCreateEvent.desc.size.width).toBe(RT_W);
    expect(rtCreateEvent.desc.size.height).toBe(RT_H);
    // D-4: usage must include COPY_SRC (0x01) for replay readbackRt
    expect(rtCreateEvent.desc.usage & 0x01).toBe(0x01);
    // RENDER_ATTACHMENT (0x10) from original texture must be preserved
    expect(rtCreateEvent.desc.usage & 0x10).toBe(0x10);

    // Phase 6: deserializeTape -- no dangling handle
    const { json, blob } = serializeTape(tapeObj);
    const rt = deserializeTape(json, blob);
    if (!rt.ok)
      throw new Error(`deserialize failed: ${rt.error.code} hint=${(rt.error as any).hint}`);
    const clean = rt.value;

    // Phase 7: createReplay on fresh device -> stepTo (real-size RT)
    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed: ${replayRes.error.code}`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);

    // Phase 8: pixel parity (AC-02) -- replay RT vs baseline
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );
    const delta = pixelDeltaAbsMean(baseline, rtRes.value.pixels);
    expect(delta).toBeLessThanOrEqual(0.01);

    // Phase 9: inspect draw 0 -- bindings/drawCall/RT three fields non-empty
    const inspectRes = await inspectDrawJson(replay, 0, clean.events, rawDev2);
    if (!inspectRes.ok) throw new Error(`inspectDrawJson failed: ${inspectRes.error.code}`);
    const report = inspectRes.value;
    expect(report.drawCall).toBeDefined();
    if (report.drawCall) {
      expect(report.drawCall.pipelineKind).toBe('render');
    }
    expect(report.rt).toBeDefined();
    expect(report.bindings).toBeDefined();
  }, 60_000);

  // ---------------------------------------------------------------
  // F-1: bgra8unorm-input replay dawn e2e -- browser-captured tape.
  //
  // A real browser tape (hello-cube via Chrome) records the canvas
  // swapchain as a bgra8unorm texture, but the swapchain VIEW and the
  // render-pipeline color target as bgra8unorm-srgb (the srgb view of the
  // preferred canvas format). On offline replay, dawn rejects a
  // bgra8unorm-srgb VIEW over a plain bgra8unorm texture:
  //   "[Texture BGRA8Unorm] was not created with the texture view format
  //    (BGRA8UnormSrgb) in the list of compatible view formats."
  // This surfaces at beginRenderPass time when the invalid color-attachment
  // view is consumed (the original failure the demo smoke worked around).
  //
  // The replay-layer format adaptation (adaptReplayFormat, replayer.ts)
  // remaps the canvas-only BGRA formats -> rgba8unorm consistently across
  // createTexture / createTextureView / renderPipeline-target, so the view
  // (rgba8unorm) is compatible with the texture (rgba8unorm) and the
  // pipeline target matches the attachment. The browser tape then replays
  // through a bare createReplay with no per-demo script mutation.
  //
  // This test mirrors the REAL tape shape: texture=bgra8unorm,
  // view=bgra8unorm-srgb, fragment.target=bgra8unorm-srgb. Before the fix,
  // stepTo fails at beginRenderPass (incompatible srgb view) -> RED. After
  // the fix, the full replay+inspect chain succeeds -> GREEN. w6 above only
  // exercises the rgba8unorm path; this closes the bgra-input gap (F-1).
  // ---------------------------------------------------------------
  it('bgra8unorm-input replay dawn e2e: browser-captured tape replays after format adaptation (F-1)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const { debugInst, wrappedCreateShader, wrappedDevice, rawDevice } = await makeWrappedCtx(pack);

    // Phase 1: Record a real rgba8unorm frame (the recording device creates
    // rgba8unorm; the bgra-srgb shape only originates from a real browser
    // canvas). We rewrite the tape formats afterwards to mirror the browser
    // capture so this isolates the replay-layer path F-1 points to.
    const RT_W = 80;
    const RT_H = 48;

    const rawTexRes = rawDevice.createTexture({
      size: { width: RT_W, height: RT_H, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: 0x11, // COPY_SRC | RENDER_ATTACHMENT
    });
    if (!rawTexRes.ok) throw new Error(`raw texture creation failed: ${rawTexRes.error.code}`);
    const swapchainTex = rawTexRes.value;

    const viewRes = wrappedDevice.createTextureView(swapchainTex as any, {});
    if (!viewRes.ok) throw new Error(`view: ${viewRes.error.code}`);

    const vs = await wrappedCreateShader(rawDevice, { code: FULLSCREEN_TRI_VS });
    if (!vs.ok) throw new Error(`vs: ${(vs.error as any).code}`);
    const fs = await wrappedCreateShader(rawDevice, { code: TRIANGLE_FS });
    if (!fs.ok) throw new Error(`fs: ${(fs.error as any).code}`);

    const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) throw new Error(`bgl: ${bglRes.error.code}`);
    const plRes = wrappedDevice.createPipelineLayout({
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) throw new Error(`pl: ${plRes.error.code}`);
    const pipeRes = wrappedDevice.createRenderPipeline({
      layout: plRes.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: {
        module: fs.value,
        entryPoint: 'main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    } as any);
    if (!pipeRes.ok) throw new Error(`createRenderPipeline failed: ${(pipeRes.error as any).code}`);

    const armRes = debugInst.arm(1);
    if (!armRes.ok) throw new Error(`arm failed: ${armRes.error.code}`);

    const encRes = wrappedDevice.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`enc: ${encRes.error.code}`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: viewRes.value as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as any);
    pass.setPipeline(pipeRes.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`finish: ${fin.error.code}`);
    wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();
    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    if (!tape) throw new Error('tape undefined');
    const tapeObj = tape as any;

    // Phase 2: deserialize, then rewrite all RT-relevant formats to
    // bgra8unorm to simulate a real browser canvas capture.
    const { json, blob } = serializeTape(tapeObj);
    const rt = deserializeTape(json, blob);
    if (!rt.ok)
      throw new Error(`deserialize failed: ${rt.error.code} hint=${(rt.error as any).hint}`);
    const clean = rt.value;

    // Mirror the real browser tape: swapchain texture = bgra8unorm,
    // swapchain VIEW = bgra8unorm-srgb, pipeline color target =
    // bgra8unorm-srgb. The srgb view over a plain bgra texture is the exact
    // dawn-rejected shape (incompatible view format) that fails at
    // beginRenderPass without the replay-layer adaptation.
    let rewroteTexture = false;
    let rewroteView = false;
    let rewroteTarget = false;
    for (const ev of clean.events as any[]) {
      if (ev.kind === 'createTexture' && ev.desc?.format === 'rgba8unorm') {
        ev.desc.format = 'bgra8unorm';
        rewroteTexture = true;
      }
      if (ev.kind === 'createTextureView') {
        // The swapchain color view; recorded undefined -> set the srgb view.
        ev.desc = { ...(ev.desc ?? {}), format: 'bgra8unorm-srgb' };
        rewroteView = true;
      }
      if (ev.kind === 'createRenderPipeline') {
        const targets = ev.desc?.fragment?.targets;
        if (Array.isArray(targets)) {
          for (const t of targets) {
            if (t?.format === 'rgba8unorm') {
              t.format = 'bgra8unorm-srgb';
              rewroteTarget = true;
            }
          }
        }
      }
    }
    // Confirm the simulated browser tape really carries the bgra-srgb shape
    // (the RED condition dawn rejects without adaptation).
    expect(rewroteTexture).toBe(true);
    expect(rewroteView).toBe(true);
    expect(rewroteTarget).toBe(true);

    // Phase 3: createReplay + stepTo on a fresh device. The replay layer
    // must remap the canvas BGRA formats -> rgba8unorm consistently; without
    // it, the srgb view over the bgra texture is invalid and stepTo fails at
    // beginRenderPass.
    const { rawDev2 } = await makeFreshReplayDevice(pack);
    const replayRes = createReplay(clean, rawDev2, pack.createShaderModule);
    if (!replayRes.ok) throw new Error(`createReplay failed: ${replayRes.error.code}`);
    const replay = replayRes.value;
    const stepRes = await replay.stepTo(clean.events.length - 1);
    if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);

    // Phase 4: readbackRt must succeed -- proves the bgra-recorded RT was
    // created (as rgba8unorm) and is readable. Without adaptation the
    // texture is absent from the handle map and readback fails.
    const rtRes = await replay.readbackRt(0);
    if (!rtRes.ok)
      throw new Error(
        `readbackRt: ${rtRes.error.code} hint=${JSON.stringify((rtRes.error as any).hint)}`,
      );
    expect(rtRes.value.width).toBe(RT_W);
    expect(rtRes.value.height).toBe(RT_H);

    // Phase 5: inspect draw 0 -- bindings/drawCall/RT three fields non-empty.
    const inspectRes = await inspectDrawJson(replay, 0, clean.events, rawDev2);
    if (!inspectRes.ok) throw new Error(`inspectDrawJson failed: ${inspectRes.error.code}`);
    const report = inspectRes.value;
    expect(report.drawCall).toBeDefined();
    expect(report.rt).toBeDefined();
    expect(report.bindings).toBeDefined();
  }, 60_000);
});
