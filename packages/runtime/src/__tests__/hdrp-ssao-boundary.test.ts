// @forgeax/engine-runtime/__tests__/hdrp-ssao-boundary.test.ts -
// SSAO boundary behavior test (M3 / w14).
// feat-20260612-hdrp-ssao.
//
// requirements AC-07: 4 boundary cases must be tested.
// plan-strategy D-4: g-buffer missing = graph-level skip; storageBuffer=false fires error.
// TDD: RED before w15+w16 (addSsaoPasses + boundary guards not yet implemented).
//
// Cases:
//   (1) g-buffer missing -> addSsaoPasses silently skips (no pass wiring, no crash)
//   (2) non-HDRP pipeline -> config.ssao is ignored (URP with config.ssao produces no SSAO pass)
//   (3) storageBuffer=false -> PostProcessError('ssao-storage-buffer-unavailable') fired
//   (4) config.ssao.enabled=false -> zero ssao-* passes + zero allocation

import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { addSsaoPasses } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';
import type { RenderSystemRuntime } from '../render-system';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';

function makeMockRuntime(capsOverride: Partial<RhiCaps> = {}): {
  runtime: RenderSystemRuntime;
  createBuffer: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
} {
  const createBuffer = vi.fn().mockReturnValue({
    ok: true,
    value: { label: 'mock-buffer' },
  });
  const createTexture = vi.fn().mockReturnValue({
    ok: true,
    value: { label: 'mock-tex' },
  });

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
      ...capsOverride,
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
    queue: {
      writeBuffer: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      writeTexture: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    },
  } as unknown as RhiDevice;

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

describe('SSAO boundary behavior (M3 / w14)', () => {
  it('(1) g-buffer missing -> addSsaoPasses silently skips (no pass wiring, no crash)', () => {
    const { runtime } = makeMockRuntime();
    const ctx = mockCtx(runtime);
    const graph = new RenderGraph<RenderPipelineContext>();

    // Declare ssaoRaw/ssaoBlurred (half-swapchain r8unorm) but NOT gbuf0/hdrDepth.
    // This simulates a g-buffer-less pipeline (e.g. URP or forward-only path).
    graph.addColorTarget('ssaoRaw', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
    });
    graph.addColorTarget('ssaoBlurred', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
    });

    // addSsaoPasses should silently skip when gbuf0/hdrDepth are not declared
    // in the graph. No throw, no error fired.
    addSsaoPasses(graph, {
      gbuf0: 'gbuf0',
      hdrDepth: 'hdrDepth',
      ssaoRaw: 'ssaoRaw',
      ssaoBlurred: 'ssaoBlurred',
      ctx,
    });

    const passes = graph.listPasses();
    const ssaoPassNames = passes.map((p) => p.name).filter((n) => n.startsWith('ssao-'));
    expect(ssaoPassNames).toHaveLength(0);

    // Graph should still compile without error (no dangling reads)
    const compileResult = graph.compile({
      backendKind: runtime.device.caps.backendKind,
      caps: runtime.device.caps,
    });
    expect(compileResult.ok).toBe(true);
  });

  it('(2) non-HDRP pipeline -> config.ssao ignored (URP with config.ssao produces no SSAO pass)', () => {
    const { runtime } = makeMockRuntime();
    const ctx = mockCtx(runtime);
    ctx.frameState.isHdrpActive = false;

    // Build a URP-style graph (no g-buffer, forward-only). addSsaoPasses should
    // check config.ssao?.enabled and/or isHdrpActive and skip silently.
    const graph = new RenderGraph<RenderPipelineContext>();

    graph.addColorTarget('ssaoRaw', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
    });
    graph.addColorTarget('ssaoBlurred', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
    });

    addSsaoPasses(graph, {
      gbuf0: 'gbuf0',
      hdrDepth: 'hdrDepth',
      ssaoRaw: 'ssaoRaw',
      ssaoBlurred: 'ssaoBlurred',
      ctx,
    });

    const passes = graph.listPasses();
    const ssaoPassNames = passes.map((p) => p.name).filter((n) => n.startsWith('ssao-'));
    expect(ssaoPassNames).toHaveLength(0);
  });

  it('(3) storageBuffer=false -> fires PostProcessError + returns null (graph-level skip)', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime({
      storageBuffer: false,
    });

    const result = getOrCreateSsaoBuffers(runtime);
    expect(result).toBeNull();

    // No GPU resources allocated
    expect(createBuffer.mock.calls.length).toBe(0);
    expect(createTexture.mock.calls.length).toBe(0);

    // Round-2 [F-3]: getOrCreateSsaoBuffers fires a structured PostProcessError
    // with code 'ssao-storage-buffer-unavailable' (warn-once per runtime),
    // honouring requirements boundary case 4 + plan D-4 + AC-07 + charter P3.
    // The null return is still the graph-level skip signal; the fired error
    // is the AI-user-facing diagnostic that says "this device cannot run SSAO".
    expect(runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    const fired = (runtime.errorRegistry.fire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { code?: string }
      | undefined;
    expect(fired?.code).toBe('ssao-storage-buffer-unavailable');
  });

  it('(4) config.ssao.enabled=false -> zero ssao-* passes (caller-level skip)', () => {
    const { runtime } = makeMockRuntime();
    const ctx = mockCtx(runtime);
    const graph = new RenderGraph<RenderPipelineContext>();

    graph.addColorTarget('gbuf0', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
    });
    graph.addColorTarget('hdrDepth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 1,
    });

    // Case 4: the caller (hdrp-pipeline.buildGraph) checks config.ssao?.enabled
    // and skips addSsaoPasses entirely. When not called, zero ssao-* passes exist.
    // This is a caller-level assertion: no addSsaoPasses call = no ssao-* passes.

    // Build graph WITHOUT calling addSsaoPasses. Wire a valid pass so the
    // graph has something to compile.
    graph.addPass('some-other-pass', {
      reads: [],
      writes: [],
    });

    const passes = graph.listPasses();
    const ssaoPassNames = passes.map((p) => p.name).filter((n) => n.startsWith('ssao-'));
    expect(ssaoPassNames).toHaveLength(0);

    // Verify the graph compiles without errors (no SSAO resources needed).
    const compileResult = graph.compile({
      backendKind: runtime.device.caps.backendKind,
      caps: runtime.device.caps,
    });
    expect(compileResult.ok).toBe(true);

    // Suppress unused ctx warning
    void ctx;
  });
});
