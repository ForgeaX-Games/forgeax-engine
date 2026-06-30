// frame-model.unit.test.ts — buildFrameModel SSOT, co-located with the source it tests.
//
// The viewer's viewer-model.unit.test.ts (app) is the integration check on the thin
// re-export; this file pins the shared analysis where it lives (packages/rhi-debug) and
// covers the inspect-core atoms (buildResources / scanPassStates / makePipelineState) that
// both buildFrameModel and inspectDrawJson consume — the one-SSOT guarantee.

import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { buildResources, makePipelineState, scanPassStates } from '../inspect-core';
import { computePassOffsets } from '../tape-format';
import type { RhiCallEvent, Tape } from '../types';

function makeTape(events: readonly RhiCallEvent[]): Tape {
  return {
    formatVersion: 1,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
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
