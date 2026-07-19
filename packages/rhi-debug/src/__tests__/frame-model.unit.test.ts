// frame-model.unit.test.ts — buildFrameModel SSOT, co-located with the source it tests.
//
// The viewer's viewer-model.unit.test.ts (app) is the integration check on the thin
// re-export; this file pins the shared analysis where it lives (packages/rhi-debug) and
// covers the inspect-core atoms (buildResources / scanPassStates / makePipelineState) that
// both buildFrameModel and inspectDrawJson consume — the one-SSOT guarantee.

import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { buildResources, makePipelineState, scanPassStates } from '../inspect-core';
import { computePassOffsets, DRAW_KINDS } from '../tape-format';
import type { RhiCallEvent, Tape } from '../types';

function makeTape(events: readonly RhiCallEvent[]): Tape {
  return {
    formatVersion: 1,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events,
    blobPool: new Map(),
  };
}

function makePipelineEvents(): readonly RhiCallEvent[] {
  return [
    {
      kind: 'createShaderModule',
      handleId: 'shader:vs',
      wgslCode: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }',
    },
    {
      kind: 'createRenderPipeline',
      handleId: 'pipe:1',
      desc: {
        vertex: {
          module: undefined as unknown as GPUShaderModule,
          entryPoint: 'main',
          buffers: [
            {
              arrayStride: 12,
              stepMode: 'vertex' as GPUVertexStepMode,
              attributes: [
                { format: 'float32x3' as GPUVertexFormat, offset: 0, shaderLocation: 0 },
              ],
            },
          ],
        },
        primitive: {
          topology: 'triangle-strip' as GPUPrimitiveTopology,
          cullMode: 'back' as GPUCullMode,
          frontFace: 'cw' as GPUFrontFace,
        },
        depthStencil: {
          format: 'depth32float' as GPUTextureFormat,
          depthWriteEnabled: true,
          depthCompare: 'less' as GPUCompareFunction,
        },
        multisample: { count: 4, mask: 0xffffffff, alphaToCoverageEnabled: true },
        fragment: {
          module: undefined as unknown as GPUShaderModule,
          entryPoint: 'main',
          targets: [{ format: 'bgra8unorm' as GPUTextureFormat, writeMask: 0xf }],
        },
      },
      layoutHandleId: 'layout:1',
      vertexShaderModuleHandleId: 'shader:vs',
      fragmentShaderModuleHandleId: undefined,
    },
    { kind: 'frameMark', frameIdx: 0 },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:1'],
    },
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 4,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
  ];
}

describe('buildFrameModel — pipeline-bearing tape', () => {
  const tape = makeTape(makePipelineEvents());
  const model = buildFrameModel(tape);

  it('meta + tree counts match computePassOffsets', () => {
    const offsets = computePassOffsets(tape.events);
    expect(model.meta.totalPasses).toBe(offsets.length);
    expect(model.meta.totalDraws).toBe(1);
    expect(model.tree).toHaveLength(1);
  });

  it('per-draw pipelineState reflects createRenderPipeline + runtime state', () => {
    const ps = model.draws[0]?.pipelineState;
    expect(ps?.inputAssembly.topology).toBe('triangle-strip');
    expect(ps?.rasterizer.cullMode).toBe('back');
    expect(ps?.rasterizer.frontFace).toBe('cw');
    expect(ps?.depthStencil.format).toBe('depth32float');
    expect(ps?.depthStencil.depthWriteEnabled).toBe(true);
    expect(ps?.multisample.count).toBe(4);
    expect(ps?.shaders.vertexShaderModuleHandleId).toBe('shader:vs');
    // Active entry points are surfaced so a multi-entrypoint module (e.g. fs_main
    // vs fs_gbuffer) is disambiguated in the pipeline panel.
    expect(ps?.shaders.vertexEntryPoint).toBe('main');
    expect(ps?.shaders.fragmentEntryPoint).toBe('main');
    expect(ps?.blend.colorTargets[0]?.format).toBe('bgra8unorm');
  });

  it('resources map carries the pipeline + shader descriptors', () => {
    expect(model.resources.get('pipe:1')?.kind).toBe('createRenderPipeline');
    expect(model.resources.get('shader:vs')?.kind).toBe('createShaderModule');
  });

  it('commands stream excludes meta events (frameMark)', () => {
    expect(model.commands.some((c) => c.kind === 'frameMark')).toBe(false);
    expect(model.commands.some((c) => c.kind === 'beginRenderPass')).toBe(true);
  });
});

describe('inspect-core atoms — shared SSOT used by buildFrameModel + inspectDrawJson', () => {
  const events = makePipelineEvents();

  it('buildResources + scanPassStates + makePipelineState compose to the same pipelineState', () => {
    const resources = buildResources(events);
    const passStates = scanPassStates(events);
    const passState = passStates[0];
    expect(passState).toBeDefined();
    if (!passState) return;
    const ps = makePipelineState(passState.pipelineHandleId, resources, passState);

    const fromModel = buildFrameModel(makeTape(events)).draws[0]?.pipelineState;
    expect(ps).toEqual(fromModel);
  });

  it('makePipelineState falls back to defaults when no pipeline bound', () => {
    const resources = buildResources(events);
    const ps = makePipelineState(undefined, resources, {
      handleId: '',
      pipelineHandleId: undefined,
      vertexBuffers: new Map(),
      indexBuffer: undefined,
      blendConstant: undefined,
      stencilReference: 0,
      depthStencilViewHandleId: undefined,
      depthStencilAttachment: undefined,
    });
    expect(ps.inputAssembly.topology).toBe('triangle-list');
    expect(ps.depthStencil.format).toBe('depth24plus');
    expect(ps.multisample.count).toBe(1);
  });
});

// ============================================================================
// m1-1: DRAW_KINDS SSOT + indexBuffer surfaces on DrawEntry
// ============================================================================

describe('m1-1 SSOT — DRAW_KINDS covers all draw + indirect + dispatch kinds', () => {
  it('the exported set matches the 5 canonical draw/dispatch kinds; frame-model + inspect-core count the same', () => {
    // SSOT membership (locks any future addition/removal from silently drifting between callers).
    expect(DRAW_KINDS.has('draw')).toBe(true);
    expect(DRAW_KINDS.has('drawIndexed')).toBe(true);
    expect(DRAW_KINDS.has('drawIndirect')).toBe(true);
    expect(DRAW_KINDS.has('drawIndexedIndirect')).toBe(true);
    expect(DRAW_KINDS.has('dispatchWorkgroups')).toBe(true);
    expect(DRAW_KINDS.size).toBe(5);

    // Build a tape covering all 5 kinds. buildFrameModel.meta.totalDraws is the
    // pure-frame-model side; countDraws (inspect-core internal via SSOT) is the
    // per-draw / drawIdx bounds check side. Both must agree on the same 5.
    const events: readonly RhiCallEvent[] = [
      { kind: 'frameMark', frameIdx: 0 },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:1'],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 3,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:ind1',
        indirectOffset: 0,
      },
      {
        kind: 'drawIndexedIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:ind2',
        indirectOffset: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:2', passHandleId: 'cpass:1' },
      { kind: 'dispatchWorkgroups', passHandleId: 'cpass:1', x: 1, y: 1, z: 1 },
      { kind: 'endComputePass', passHandleId: 'cpass:1' },
    ];

    const model = buildFrameModel(makeTape(events));
    expect(model.meta.totalDraws).toBe(5);
    // pass offsets is the third independent counter — same SSOT closes the loop.
    const offsets = computePassOffsets(events);
    const spanned = offsets.reduce(
      (acc, o) => acc + Math.max(0, o.endDrawIdx - o.startDrawIdx + 1),
      0,
    );
    expect(spanned).toBe(5);
  });
});

describe('m1-1 DrawEntry.indexBuffer — mirrors setIndexBuffer event', () => {
  it('propagates handleId + format + offset onto every draw in the pass; undefined before setIndexBuffer', () => {
    const events: readonly RhiCallEvent[] = [
      { kind: 'frameMark', frameIdx: 0 },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:1'],
      },
      { kind: 'createRenderPipeline', handleId: 'pipe:1', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
      {
        kind: 'setIndexBuffer',
        passHandleId: 'pass:1',
        bufferHandleId: 'buf:ib',
        format: 'uint16',
        offset: 8,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 6,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const model = buildFrameModel(makeTape(events));
    const draw = model.draws[0];
    expect(draw?.indexBuffer?.handleId).toBe('buf:ib');
    expect(draw?.indexBuffer?.format).toBe('uint16');
    expect(draw?.indexBuffer?.offset).toBe(8);
  });
});
