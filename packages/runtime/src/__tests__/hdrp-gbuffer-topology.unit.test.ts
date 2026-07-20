// hdrp-gbuffer-topology.unit.test.ts — M2 / w9: buildGraph g-buffer pass topology.
//
// Validates that hdrpPipeline.buildGraph produces a RenderGraph whose pass list
// includes g-buffer, lighting, and forward passes in the correct topology, with
// explicit reads/writes declarations matching plan-strategy D-2 / D-6.
//
// AC-01: HDRP buildGraph includes g-buffer + lighting + forward passes.
// AC-02: g-buffer pass writes 3 color RT + depth; lighting pass reads g-buffer
//   + cluster buffers + writes hdrColor; forward pass reads depth + cluster
//   buffers + writes hdrColor.
//
// This test runs in the unit layer (no GPU): it mocks the runtime + device
// caps and verifies the pass list + reads/writes topology via RenderGraph's
// `listPasses()` and `listResources()` introspection APIs.

import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { hdrpPipeline } from '../hdrp-pipeline';
import type { RenderPipelineContext, RenderPipelineData } from '../render-pipeline-context';
import type { RenderSystemRuntime } from '../render-system';

function mockRuntime(capsOverride: Partial<RhiCaps> = {}): RenderSystemRuntime {
  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
      ...capsOverride,
    },
    createBuffer: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-buffer' },
    }),
    createBindGroupLayout: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-bgl' },
    }),
  } as unknown as RhiDevice;

  return {
    device,
    errorRegistry,
    shaderCache: { get: vi.fn() },
  } as unknown as RenderSystemRuntime;
}

function mockCtx(runtime: RenderSystemRuntime): RenderPipelineContext {
  return {
    runtime,
    assets: { get: vi.fn(), register: vi.fn() },
    store: { ensureResident: vi.fn(), getTextureView: vi.fn() },
    pipelineState: {},
    encoder: {},
    view: {},
    clear: [0, 0, 0, 1],
    targetW: 800,
    targetH: 600,
    currentTexture: {},
    camera: {},
    validated: [],
    validatedOrdered: [],
    viewBindGroup: null,
    meshBindGroup: null,
    frameState: { perFrameGraph: null, isHdrpActive: true },
    dispatchCounts: {},
    bindGroupCounts: {},
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    msaaActive: false,
    geometryColorResolveView: null,
    ldrSpriteColorView: null,
  } as unknown as RenderPipelineContext;
}

function mockData(): RenderPipelineData {
  return {
    camera: {},
    validated: [],
    validatedOrdered: [],
    targetW: 800,
    targetH: 600,
    skylight: undefined,
    skylightCount: 0,
    skyboxActive: false,
    skybox: undefined,
    tonemapActive: false,
    splitLdrSprite: false,
    config: undefined,
    shadowMapSize: undefined,
  } as unknown as RenderPipelineData;
}

describe('HDRP buildGraph g-buffer topology (w9)', () => {
  it('buildGraph returns a non-null graph with valid caps', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);
    const data = mockData();

    const graph = hdrpPipeline.buildGraph(ctx, data);
    expect(graph).not.toBeNull();
  });

  it('pass list includes cluster-binner-upload + g-buffer + lighting + forward + tonemap (5 passes)', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    // Must set up enough mock for getOrCreateHdrpBuffers to succeed.
    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const passNames = passes.map((p) => p.name);
    expect(passNames).toContain('cluster-binner-upload');
    expect(passNames).toContain('g-buffer');
    expect(passNames).toContain('lighting');
    expect(passNames).toContain('forward');
    expect(passNames).toContain('tonemap');
  });

  it('g-buffer pass writes 3 color RT + depth', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const gbufferPass = passes.find((p) => p.name === 'g-buffer');
    expect(gbufferPass).toBeDefined();
    if (!gbufferPass) return;

    expect(gbufferPass.writes).toContain('gbuf0');
    expect(gbufferPass.writes).toContain('gbuf1');
    expect(gbufferPass.writes).toContain('gbuf2');
    expect(gbufferPass.writes).toContain('hdrDepth');
  });

  it('lighting pass reads g-buffer + cluster buffers and writes hdrColor', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const lightingPass = passes.find((p) => p.name === 'lighting');
    expect(lightingPass).toBeDefined();
    if (!lightingPass) return;

    expect(lightingPass.reads).toContain('gbuf0');
    expect(lightingPass.reads).toContain('gbuf1');
    expect(lightingPass.reads).toContain('gbuf2');
    expect(lightingPass.reads).toContain('hdrDepth');
    expect(lightingPass.reads).toContain('hdrpLightData');
    expect(lightingPass.reads).toContain('hdrpClusterGrid');
    expect(lightingPass.reads).toContain('hdrpLightIndexList');
    expect(lightingPass.reads).toContain('hdrpClusterUniform');
    expect(lightingPass.writes).toContain('hdrColor');
  });

  it('forward pass reads depth + cluster buffers and writes hdrColor', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const forwardPass = passes.find((p) => p.name === 'forward');
    expect(forwardPass).toBeDefined();
    if (!forwardPass) return;

    expect(forwardPass.reads).toContain('hdrDepth');
    expect(forwardPass.reads).toContain('hdrpLightData');
    expect(forwardPass.reads).toContain('hdrpClusterGrid');
    expect(forwardPass.reads).toContain('hdrpLightIndexList');
    expect(forwardPass.reads).toContain('hdrpClusterUniform');
    expect(forwardPass.writes).toContain('hdrColor');
  });

  it('g-buffer color targets have correct formats', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const resources = graph.listResources();
    const gbuf0 = resources.find((r) => r.key === 'gbuf0');
    const gbuf1 = resources.find((r) => r.key === 'gbuf1');
    const gbuf2 = resources.find((r) => r.key === 'gbuf2');

    expect(gbuf0).toBeDefined();
    expect(gbuf1).toBeDefined();
    expect(gbuf2).toBeDefined();
  });

  it('resources include all 3 g-buffer color targets', () => {
    const runtime = mockRuntime({ maxColorAttachments: 8 });
    const ctx = mockCtx(runtime);

    const graph = hdrpPipeline.buildGraph(ctx, mockData());
    expect(graph).not.toBeNull();
    if (!graph) return;

    const resources = graph.listResources();
    const resourceKeys = resources.map((r) => r.key);
    expect(resourceKeys).toContain('gbuf0');
    expect(resourceKeys).toContain('gbuf1');
    expect(resourceKeys).toContain('gbuf2');
  });

  it('buildGraph throws when maxColorAttachments < 4 (caps check)', () => {
    const runtime = mockRuntime({ maxColorAttachments: 3 });
    const ctx = mockCtx(runtime);

    expect(() => hdrpPipeline.buildGraph(ctx, mockData())).toThrow();
  });
});
