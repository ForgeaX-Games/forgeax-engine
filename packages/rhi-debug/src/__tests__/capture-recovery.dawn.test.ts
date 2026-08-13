/// <reference types="@webgpu/types" />

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { afterAll, describe, expect, it } from 'vitest';
import { captureFramesToMemory } from '../capture-browser';
import { inspectDrawJson } from '../inspect-core';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { finalizeToMemory } from '../recorder-core';
import { createReplay } from '../replayer';
import { deserializeTape } from '../tape-format';

// Dawn-node exposes opaque GPU handles through the RHI boundary; these casts
// are limited to the test's WebGPU descriptor construction.

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
const SIZE = 32;
const teardownDevices: RhiDevice[] = [];

const VS = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.8, -0.8),
    vec2<f32>(0.8, -0.8),
    vec2<f32>(0.0, 0.8),
  );
  return vec4<f32>(positions[vi], 0.0, 1.0);
}`;

const FS = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.7, 0.9, 1.0);
}`;

async function makeCaptureScene(pack: DawnPack) {
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);
  const adapterResult = await debugInst.requestAdapter();
  if (!adapterResult.ok) throw new Error(`adapter: ${adapterResult.error.code}`);
  const deviceResult = await adapterResult.value.requestDevice();
  if (!deviceResult.ok) throw new Error(`device: ${deviceResult.error.code}`);
  const wrappedDevice = deviceResult.value;
  const rawDevice = (wrappedDevice as RhiDevice & { _realDevice: RhiDevice })._realDevice;

  const targetResult = wrappedDevice.createTexture({
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x11,
  });
  if (!targetResult.ok) throw new Error(`target: ${targetResult.error.code}`);
  const viewResult = wrappedDevice.createTextureView(targetResult.value, {});
  if (!viewResult.ok) throw new Error(`view: ${viewResult.error.code}`);
  const vertexResult = await wrappedCreateShader(rawDevice, { code: VS });
  if (!vertexResult.ok) throw new Error(`vertex: ${vertexResult.error.code}`);
  const fragmentResult = await wrappedCreateShader(rawDevice, { code: FS });
  if (!fragmentResult.ok) throw new Error(`fragment: ${fragmentResult.error.code}`);
  const bindLayoutResult = wrappedDevice.createBindGroupLayout({ entries: [] });
  if (!bindLayoutResult.ok) throw new Error(`bind layout: ${bindLayoutResult.error.code}`);
  const pipelineLayoutResult = wrappedDevice.createPipelineLayout({
    bindGroupLayouts: [bindLayoutResult.value],
  });
  if (!pipelineLayoutResult.ok)
    throw new Error(`pipeline layout: ${pipelineLayoutResult.error.code}`);
  const pipelineResult = wrappedDevice.createRenderPipeline({
    layout: pipelineLayoutResult.value,
    vertex: { module: vertexResult.value, entryPoint: 'main', buffers: [] },
    fragment: {
      module: fragmentResult.value,
      entryPoint: 'main',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  } as unknown as Parameters<typeof wrappedDevice.createRenderPipeline>[0]);
  if (!pipelineResult.ok) throw new Error(`pipeline: ${pipelineResult.error.code}`);

  // Keep the failure reproducible on a real queue: the bounded retry path
  // must cross actual Dawn readbacks, not a test-only never-settling promise.
  // These bootstrap textures are intentionally unused by the draw but remain
  // valid live resources, so the frame-header snapshot has enough real GPU
  // work to exceed a 1 ms bound before the retry proves the normal path.
  for (let i = 0; i < 8; i += 1) {
    const seedResult = wrappedDevice.createTexture({
      size: { width: 128, height: 128, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x11,
    });
    if (!seedResult.ok) throw new Error(`seed texture ${i}: ${seedResult.error.code}`);
  }

  const drawFrame = async () => {
    const encoderResult = wrappedDevice.createCommandEncoder({});
    if (!encoderResult.ok) throw new Error(`encoder: ${encoderResult.error.code}`);
    const pass = encoderResult.value.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value,
          clearValue: { r: 0.03, g: 0.04, b: 0.05, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as unknown as GPURenderPassDescriptor);
    pass.setPipeline(pipelineResult.value);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const commandResult = encoderResult.value.finish();
    if (!commandResult.ok) throw new Error(`finish: ${commandResult.error.code}`);
    wrappedDevice.queue.submit([commandResult.value] as unknown as readonly never[]);
    await wrappedDevice.queue.onSubmittedWorkDone();
  };

  return { debugInst, wrappedDevice, drawFrame };
}

async function captureWithFrame(
  debugInst: Awaited<ReturnType<typeof makeCaptureScene>>['debugInst'],
  options?: { readonly snapshotTimeoutMs?: number },
) {
  const pump = setInterval(() => debugInst.onFrameEnd(), 1);
  try {
    return await captureFramesToMemory(debugInst, 1, 'p9-recovery', options);
  } finally {
    clearInterval(pump);
  }
}

async function captureAfterPublicRecovery(
  debugInst: Awaited<ReturnType<typeof makeCaptureScene>>['debugInst'],
  drawFrame: () => Promise<void>,
) {
  debugInst.disposeError();
  debugInst.disposeError();
  const armResult = debugInst.arm(1);
  if (!armResult.ok) throw new Error(`retry arm: ${armResult.error.code}`);
  const snapshotResult = await debugInst.snapshotAllLiveResources();
  if (!snapshotResult.ok) throw new Error(`retry snapshot: ${snapshotResult.error.code}`);
  await drawFrame();
  await new Promise<void>((resolve) => {
    const pump = setInterval(() => {
      debugInst.onFrameEnd();
      if (debugInst.getState() === 'idle') {
        clearInterval(pump);
        resolve();
      }
    }, 1);
  });
  const finalizeResult = finalizeToMemory(debugInst);
  if (!finalizeResult.ok) throw new Error(`retry finalize: ${finalizeResult.error.code}`);
  return finalizeResult.value;
}

afterAll(() => {
  for (const device of teardownDevices)
    (device as RhiDevice & { destroy?: () => void }).destroy?.();
  teardownDevices.length = 0;
});

describe.skipIf(SKIP_DAWN)('public capture failure recovery on Dawn', () => {
  it('retains one timeout, retries, replays, inspects, and remains idempotent', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const scene = await makeCaptureScene(pack);
    const { debugInst } = scene;
    const firstFailure = await captureWithFrame(debugInst, { snapshotTimeoutMs: 1 }).catch(
      (error: unknown) => error as { code?: string; detail?: unknown },
    );

    expect(firstFailure).toMatchObject({ code: 'snapshot-timeout' });
    expect(debugInst.getState()).toBe('error');
    expect(firstFailure).toMatchObject({ detail: { timeoutMs: 1 } });

    const retryTape = await captureAfterPublicRecovery(debugInst, scene.drawFrame);
    expect(retryTape.valid).toBe(true);
    expect(debugInst.getState()).toBe('idle');

    const decoded = deserializeTape(retryTape.json, retryTape.blob);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const replayAdapter = await pack.rhi.requestAdapter();
    if (!replayAdapter.ok) throw new Error(`replay adapter: ${replayAdapter.error.code}`);
    const replayDevice = await replayAdapter.value.requestDevice();
    if (!replayDevice.ok) throw new Error(`replay device: ${replayDevice.error.code}`);
    teardownDevices.push(replayDevice.value);
    const replayResult = createReplay(decoded.value, replayDevice.value, pack.createShaderModule);
    expect(replayResult.ok).toBe(true);
    if (!replayResult.ok) return;
    const stepResult = await replayResult.value.stepTo(decoded.value.events.length - 1);
    expect(stepResult.ok).toBe(true);
    if (!stepResult.ok) return;
    const inspectResult = await inspectDrawJson(
      replayResult.value,
      0,
      decoded.value.events,
      replayDevice.value,
    );
    if (!inspectResult.ok)
      throw new Error(`inspect: ${inspectResult.error.code} ${inspectResult.error.hint}`);
    expect(inspectResult.value.drawCall).toBeDefined();
    expect(inspectResult.value.rt).toBeDefined();

    debugInst.disposeError();
    debugInst.disposeError();
    expect(debugInst.getState()).toBe('idle');
    const secondRetryTape = await captureAfterPublicRecovery(debugInst, scene.drawFrame);
    expect(secondRetryTape.valid).toBe(true);
    expect(debugInst.getState()).toBe('idle');
  }, 60_000);
});
