// @forgeax/engine-runtime/__tests__/hdrp-ssao-graph.test.ts -
// SSAO buildGraph integration test (M4 / w17).
// feat-20260612-hdrp-ssao.
//
// requirements AC-02: ssao-calc/ssao-blur pass chain present when enabled.
// plan-strategy D-4: g-buffer missing -> no SSAO passes.
// plan-strategy D-7: lighting pass reads ssaoBlurred.
// TDD: RED before w19 (config.ssao type narrowing + hdrp-pipeline wiring).
//
// Tests:
//   - config.ssao.enabled=true -> passes include ssao-calc + ssao-blur
//     in order between g-buffer and lighting; lighting.reads includes ssaoBlurred
//   - config.ssao.enabled=false -> zero ssao-* passes

import { describe, expect, it, vi } from 'vitest';
import type { RenderPipelineContext, RenderPipelineData } from '../render-pipeline-context';
import type { RenderSystemRuntime } from '../render-system';

// Minimal mock that satisfies the buildGraph contract. We need enough of a
// RenderSystemRuntime that getOrCreateHdrpBuffers and getOrCreateSsaoBuffers
// resolve cleanly, and the graph compile succeeds without a real device.
function makeMockRuntime(): {
  runtime: RenderSystemRuntime;
  createBuffer: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
} {
  const createBuffer = vi.fn().mockReturnValue({
    ok: true,
    value: { label: 'mock-buffer', release: vi.fn() },
  });
  const createTexture = vi.fn().mockReturnValue({
    ok: true,
    value: { label: 'mock-tex', release: vi.fn() },
  });
  const getBuffer = vi.fn().mockReturnValue('mock-gpu-buffer');

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
    },
    createBuffer,
    createTexture,
    createTextureView: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-tex-view' },
    }),
    createSampler: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-sampler' },
    }),
    createBindGroupLayout: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-bgl' },
    }),
    getBuffer,
    queue: {
      writeBuffer: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      writeTexture: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    },
  } as unknown as RenderSystemRuntime['device'];

  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const runtime = {
    device,
    errorRegistry,
    shaderCache: { get: vi.fn() },
  } as unknown as RenderSystemRuntime;

  return { runtime, createBuffer, createTexture };
}

function makeMockCtx(runtime: RenderSystemRuntime): RenderPipelineContext {
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

function makeMockData(config?: Record<string, unknown>): RenderPipelineData {
  return {
    camera: {} as RenderPipelineData['camera'],
    validated: [],
    validatedOrdered: [],
    targetW: 800,
    targetH: 600,
    skylight: undefined,
    skylightCount: 0,
    skyboxActive: false,
    skybox: undefined,
    tonemapActive: true,
    splitLdrSprite: false,
    config: config as RenderPipelineData['config'],
    shadowMapSize: undefined,
    cascadeCount: undefined,
  };
}

describe('hdrp-pipeline buildGraph SSAO integration (M4 / w17)', () => {
  it('config.ssao.enabled=true: passes include ssao-calc + ssao-blur between g-buffer and lighting', async () => {
    const { runtime } = makeMockRuntime();
    const ctx = makeMockCtx(runtime);
    const data = makeMockData({ ssao: { enabled: true } });

    // Dynamic import to avoid hoist issues — the pipeline needs the full
    // engine runtime to be wired (getOrCreateHdrpBuffers, getOrCreateSsaoBuffers).
    const { hdrpPipeline } = await import('../hdrp-pipeline');
    const graph = hdrpPipeline.buildGraph(ctx, data);
    expect(graph).not.toBeNull();
    if (graph === null) return; // type-narrow guard

    const passes = graph.listPasses();
    const passNames = passes.map((p) => p.name);

    // Verify ssao-calc and ssao-blur exist
    expect(passNames).toContain('ssao-calc');
    expect(passNames).toContain('ssao-blur');

    // Verify ordering: g-buffer before ssao-calc, ssao-blur after ssao-calc,
    // lighting after ssao-blur
    const gbufIdx = passNames.indexOf('g-buffer');
    const calcIdx = passNames.indexOf('ssao-calc');
    const blurIdx = passNames.indexOf('ssao-blur');
    const lightingIdx = passNames.indexOf('lighting');

    expect(gbufIdx).toBeLessThan(calcIdx);
    expect(calcIdx).toBeLessThan(blurIdx);
    expect(blurIdx).toBeLessThan(lightingIdx);

    // Verify lighting pass reads ssaoBlurred
    const lightingPass = passes[lightingIdx];
    expect(lightingPass).toBeDefined();
    expect(lightingPass?.reads).toContain('ssaoBlurred');
  });

  it('config.ssao.enabled=false: zero ssao-* passes', async () => {
    const { runtime } = makeMockRuntime();
    const ctx = makeMockCtx(runtime);
    const data = makeMockData({ ssao: { enabled: false } });

    const { hdrpPipeline } = await import('../hdrp-pipeline');
    const graph = hdrpPipeline.buildGraph(ctx, data);
    expect(graph).not.toBeNull();

    if (graph === null) return;
    const passes = graph.listPasses();
    const ssaoPassNames = passes.map((p) => p.name).filter((n) => n.startsWith('ssao-'));
    expect(ssaoPassNames).toHaveLength(0);
  });

  it('config.ssao absent (undefined): zero ssao-* passes', async () => {
    const { runtime } = makeMockRuntime();
    const ctx = makeMockCtx(runtime);
    // config without ssao field
    const data = makeMockData({ clusterGrid: { x: 16, y: 9, z: 24 } });

    const { hdrpPipeline } = await import('../hdrp-pipeline');
    const graph = hdrpPipeline.buildGraph(ctx, data);
    expect(graph).not.toBeNull();

    if (graph === null) return;
    const passes = graph.listPasses();
    const ssaoPassNames = passes.map((p) => p.name).filter((n) => n.startsWith('ssao-'));
    expect(ssaoPassNames).toHaveLength(0);
  });
});
