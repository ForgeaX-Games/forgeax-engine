/**
 * Replayer new handler dawn tests (M3 w9).
 *
 * AC-10: copy/clear/viewport replay produces correct behavior.
 * AC-11: setBlendConstant replay handler dispatched without error.
 * AC-12: pass-level debug group dispatched for render pass, compute pass
 *        silently skipped.
 * AC-13: drawIndirect/drawIndexedIndirect return ok(undefined) when
 *        indirect buffer unavailable, does not block subsequent replay.
 *
 * Uses real dawn-node device via @forgeax/engine-rhi-webgpu.
 * File convention: *.dawn.test.ts (dawn vitest project).
 */

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e constructs RHI opaque GPU types at test boundary

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, it } from 'vitest';
import type { CreateShaderModuleFn } from '../recorder';
import { createReplay } from '../replayer';
import type { Tape } from '../types';

// ============================================================================
// dawn-node RHI bootstrap
// ============================================================================

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

const RT_WIDTH = 64;
const RT_HEIGHT = 64;

const VS_WGSL = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2( 0.0,  0.5),
    vec2(-0.5, -0.5),
    vec2( 0.5, -0.5),
  );
  return vec4(pos[vi], 0.0, 1.0);
}`;

const FS_RED = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(1.0, 0.0, 0.0, 1.0);
}`;

/**
 * Construct a tape with the given events array.
 */
function buildTapeWithEvents(events: readonly Record<string, unknown>[]): Tape {
  return {
    formatVersion: 3,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events: events as unknown as Tape['events'],
    blobPool: new Map(),
  };
}

/**
 * Helper: bootstrap dawn, create replay from tape, step to end, return replay for cleanup.
 */
async function createAndStepReplay(
  pack: DawnPack,
  tape: Tape,
): Promise<{ replay: any; device: RhiDevice }> {
  const devRes = await (await pack.rhi.requestAdapter()).unwrap();
  const device = (await devRes.requestDevice()).unwrap();
  const replayRes = createReplay(tape, device, pack.createShaderModule);
  if (!replayRes.ok) throw new Error(`createReplay failed: ${replayRes.error}`);
  const stepResult = await replayRes.value.stepTo(tape.events.length - 1);
  if (!stepResult.ok) throw new Error(`stepTo failed: ${stepResult.error.code}`);
  return { replay: replayRes.value, device };
}

/**
 * Minimal tape events to create resources, draw a triangle, and end the frame.
 */
function minimalDrawEvents(extra: Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return [
    {
      kind: 'createTexture',
      handleId: 'tex:1',
      desc: {
        size: { width: RT_WIDTH, height: RT_HEIGHT, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0x11,
      },
    },
    { kind: 'createTextureView', sourceHandleId: 'tex:1', resultHandleId: 'tv:1', desc: {} },
    { kind: 'createShaderModule', handleId: 'sm:1', wgslCode: VS_WGSL },
    { kind: 'createShaderModule', handleId: 'sm:2', wgslCode: FS_RED },
    { kind: 'createPipelineLayout', handleId: 'pl:1', bglHandleIds: [] },
    {
      kind: 'createRenderPipeline',
      handleId: 'rp:1',
      desc: {
        vertex: { entryPoint: 'main', buffers: [] },
        primitive: { topology: 'triangle-list' },
      },
      layoutHandleId: 'pl:1',
      vertexShaderModuleHandleId: 'sm:1',
      fragmentShaderModuleHandleId: 'sm:2',
    },
    { kind: 'createCommandEncoder', cmdHandleId: 'ce:1' },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'ce:1',
      passHandleId: 'rp:1',
      desc: {
        colorAttachments: [
          { view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      },
      colorAttachmentViewHandleIds: ['tv:1'],
      depthStencilViewHandleId: undefined,
    },
    { kind: 'setPipeline', passHandleId: 'rp:1', pipelineHandleId: 'rp:1' },
    ...extra,
    {
      kind: 'draw',
      passHandleId: 'rp:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'rp:1' },
    { kind: 'finish', cmdHandleId: 'ce:1' },
    { kind: 'submit', cmdHandleIds: ['ce:1'] },
    { kind: 'frameMark', frameIdx: 0 },
  ];
}

// ============================================================================
// AC-10: copy/clear/viewport replay (existing handler validation)
// ============================================================================

describe.skipIf(SKIP_DAWN)('w9: AC-10 copy/clear/viewport replay', () => {
  it('tape with existing copy/clear/viewport events replays to completion', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const events = minimalDrawEvents([
      { kind: 'createBuffer', handleId: 'buf:0', desc: { size: 64, usage: 1 } },
      { kind: 'clearBuffer', cmdHandleId: 'ce:1', handleId: 'buf:0', offset: 0, size: 0 },
      {
        kind: 'setViewport',
        passHandleId: 'rp:1',
        x: 0,
        y: 0,
        w: RT_WIDTH,
        h: RT_HEIGHT,
        minDepth: 0,
        maxDepth: 1,
      },
    ]);
    const tape = buildTapeWithEvents(events);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });
});

// ============================================================================
// AC-11: setBlendConstant replay
// ============================================================================

describe.skipIf(SKIP_DAWN)('w9: AC-11 setBlendConstant handler', () => {
  it('setBlendConstant event replays without error', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const events = minimalDrawEvents([
      { kind: 'setBlendConstant', passHandleId: 'rp:1', color: [0.1, 0.2, 0.3, 0.4] as GPUColor },
    ]);
    const tape = buildTapeWithEvents(events);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });
});

// ============================================================================
// AC-12: pass-level debug group dispatch
// ============================================================================

describe.skipIf(SKIP_DAWN)('w9: AC-12 pass debug group dispatch', () => {
  it('render-pass debug group events replay without error', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const events = minimalDrawEvents([
      { kind: 'passPushDebugGroup', passHandleId: 'rp:1', groupLabel: 'render-group' },
    ]);
    const tape = buildTapeWithEvents(events);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });

  it('compute-pass debug group events silently skipped', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const computeEvents: Record<string, unknown>[] = [
      {
        kind: 'createShaderModule',
        handleId: 'sm:3',
        wgslCode: '@compute @workgroup_size(1) fn main() {}',
      },
      { kind: 'createPipelineLayout', handleId: 'pl:2', bglHandleIds: [] },
      {
        kind: 'createComputePipeline',
        handleId: 'cp:1',
        desc: { compute: { module: null, entryPoint: 'main' } },
        layoutHandleId: 'pl:2',
        computeShaderModuleHandleId: 'sm:3',
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'ce:1' },
      { kind: 'beginComputePass', cmdHandleId: 'ce:1', passHandleId: 'cp:1' },
      { kind: 'setComputePipeline', passHandleId: 'cp:1', pipelineHandleId: 'cp:1' },
      { kind: 'passPushDebugGroup', passHandleId: 'cp:1', groupLabel: 'compute-group' },
      { kind: 'passPopDebugGroup', passHandleId: 'cp:1' },
      { kind: 'passInsertDebugMarker', passHandleId: 'cp:1', markerLabel: 'compute-marker' },
      { kind: 'dispatchWorkgroups', passHandleId: 'cp:1', x: 1, y: 1, z: 1 },
      { kind: 'endComputePass', passHandleId: 'cp:1' },
      { kind: 'finish', cmdHandleId: 'ce:1' },
      { kind: 'submit', cmdHandleIds: ['ce:1'] },
      { kind: 'frameMark', frameIdx: 0 },
    ];
    const tape = buildTapeWithEvents(computeEvents);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });
});

// ============================================================================
// AC-13: indirect draw silent skip
// ============================================================================

describe.skipIf(SKIP_DAWN)('w9: AC-13 indirect draw silent skip', () => {
  it('drawIndirect without buffer content replays to completion without blocking', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const events = minimalDrawEvents([
      {
        kind: 'drawIndirect',
        passHandleId: 'rp:1',
        indirectBufferHandleId: 'buf:99',
        indirectOffset: 0,
      },
    ]);
    const tape = buildTapeWithEvents(events);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });

  it('drawIndexedIndirect without buffer content replays to completion', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node not available');

    const events = minimalDrawEvents([
      {
        kind: 'drawIndexedIndirect',
        passHandleId: 'rp:1',
        indirectBufferHandleId: 'buf:99',
        indirectOffset: 0,
      },
    ]);
    const tape = buildTapeWithEvents(events);

    const { replay, device } = await createAndStepReplay(pack, tape);
    try {
      replay.dispose();
    } finally {
      if (typeof (device as any).destroy === 'function') (device as any).destroy();
    }
  });
});
