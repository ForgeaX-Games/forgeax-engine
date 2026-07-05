// urp-post-effects-topology.unit.test.ts -
// feat-20260621-learn-render-5-3-production-shadow-demos M4' (post-URP hook).
//
// Validates the AUGMENT guarantee at the pipeline-build layer (no GPU): when
// installPipeline supplies config.postEffects, urpPipeline.buildGraph appends a
// `post-effect-<i>` pass per id AFTER fxaa and BEFORE debug-overlay, while the
// 9 built-in passes (shadowCascade* / skybox / main / bloom* / tonemap / fxaa)
// stay intact. This is the structural proof that the overlay layers ON TOP of
// URP rather than REPLACING it (and dropping its shadow passes) -- the exact
// regression that the prior installPipeline-replacement approach caused and
// that a shadow demo cannot afford.
//
// Runs in the unit layer: mocks runtime + device caps and reads the pass list
// via RenderGraph.listPasses().

import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { RenderPipelineContext, RenderPipelineData } from '../render-pipeline-context';
import type { RenderSystemRuntime } from '../render-system';
import { urpPipeline } from '../urp-pipeline';

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
    createBuffer: vi.fn().mockReturnValue({ ok: true, value: { label: 'mock-buffer' } }),
    createBindGroupLayout: vi.fn().mockReturnValue({ ok: true, value: { label: 'mock-bgl' } }),
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
    pipelineState: { format: 'bgra8unorm', colorAttachmentFormat: 'bgra8unorm-srgb' },
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
    frameState: { perFrameGraph: null, isHdrpActive: false },
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

function mockData(config: RenderPipelineData['config']): RenderPipelineData {
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
    config,
    shadowMapSize: 2048,
    cascadeCount: 4,
  } as unknown as RenderPipelineData;
}

describe('feat-20260621 M4′: URP config.postEffects topology (AUGMENT, not REPLACE)', () => {
  it('config=undefined -> zero post-effect passes (default frame unchanged)', () => {
    const graph = urpPipeline.buildGraph(mockCtx(mockRuntime()), mockData(undefined));
    expect(graph).not.toBeNull();
    if (!graph) return;
    const names = graph.listPasses().map((p) => p.name);
    expect(names.some((n) => n.startsWith('post-effect-'))).toBe(false);
    // The built-in chain is intact.
    expect(names).toContain('fxaa');
    expect(names).toContain('debug-overlay');
  });

  it('postEffects: [a, b] -> two post-effect passes, AFTER fxaa, BEFORE debug-overlay', () => {
    const graph = urpPipeline.buildGraph(
      mockCtx(mockRuntime()),
      mockData({ postEffects: ['pkg::a', 'pkg::b'] }),
    );
    expect(graph).not.toBeNull();
    if (!graph) return;
    const names = graph.listPasses().map((p) => p.name);

    // Two post-effect passes appended.
    expect(names).toContain('post-effect-0');
    expect(names).toContain('post-effect-1');

    // Ordering: fxaa < post-effect-0 < post-effect-1 < debug-overlay.
    const idxFxaa = names.indexOf('fxaa');
    const idx0 = names.indexOf('post-effect-0');
    const idx1 = names.indexOf('post-effect-1');
    const idxOverlay = names.indexOf('debug-overlay');
    expect(idxFxaa).toBeGreaterThanOrEqual(0);
    expect(idx0).toBeGreaterThan(idxFxaa);
    expect(idx1).toBeGreaterThan(idx0);
    expect(idxOverlay).toBeGreaterThan(idx1);
  });

  it('AUGMENT: all 4 shadow cascades survive alongside the post-effect pass', () => {
    const graph = urpPipeline.buildGraph(
      mockCtx(mockRuntime()),
      mockData({ postEffects: ['pkg::overlay'] }),
    );
    expect(graph).not.toBeNull();
    if (!graph) return;
    const names = graph.listPasses().map((p) => p.name);
    const cascades = names.filter((n) => n.startsWith('shadowCascade'));
    expect(cascades.length).toBe(4);
    expect(names).toContain('post-effect-0');
  });

  it('each post-effect declares a distinct scratch color target', () => {
    const graph = urpPipeline.buildGraph(
      mockCtx(mockRuntime()),
      mockData({ postEffects: ['pkg::a', 'pkg::b'] }),
    );
    expect(graph).not.toBeNull();
    if (!graph) return;
    const resourceKeys = graph.listResources().map((r) => r.key);
    expect(resourceKeys).toContain('postEffectScratch0');
    expect(resourceKeys).toContain('postEffectScratch1');
  });
});

// ── feat-20260702-postprocess-camera-depth-read M3 / w10 (TDD RED) ────────
// Verifies that when a registered post-effect entry declares a depth read,
// urpPipeline.buildGraph appends `reads:['depth']` to the post-effect pass
// so the graph can resolve the depth key before the overlay runs (D-6).
// RED phase: urp-pipeline currently does NOT inspect entry.reads for depth;
// it always emits compositeOverSwapchain with no reads.  After w13 impl,
// the post-effect pass reads includes 'depth'.

describe('feat-20260702 M3 w10: URP post-effects topology depth dependency edge (RED)', () => {
  it('post-effect with depth reads -> pass reads includes depth key', () => {
    // Mock runtime where lookupPostProcess returns an entry with depth reads.
    const mockLookup = vi.fn((_id: string) => ({
      source: 'fn vs_main(){} fn fs_main(){}',
      reads: [{ key: 'depth', sampleType: 'depth' as const }],
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
    }));
    const runtime = {
      ...mockRuntime(),
      lookupPostProcess: mockLookup,
    } as unknown as RenderSystemRuntime;

    const graph = urpPipeline.buildGraph(
      mockCtx(runtime),
      mockData({ postEffects: ['pkg::depth-fx'] }),
    );
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const postPass = passes.find((p) => p.name === 'post-effect-0');
    expect(postPass).toBeDefined();
    if (!postPass) return;

    // RED: urp-pipeline currently does not inspect entry.reads, so the pass
    // has NO reads key 'depth'. After w13, it appends reads:['depth'].
    expect(postPass.reads).toContain('depth');
  });

  it('post-effect without depth reads -> pass reads unchanged (no false dependency)', () => {
    const mockLookup = vi.fn((_id: string) => ({
      source: 'fn vs_main(){} fn fs_main(){}',
      // no reads -> color-only
    }));
    const runtime = {
      ...mockRuntime(),
      lookupPostProcess: mockLookup,
    } as unknown as RenderSystemRuntime;

    const graph = urpPipeline.buildGraph(
      mockCtx(runtime),
      mockData({ postEffects: ['pkg::plain'] }),
    );
    expect(graph).not.toBeNull();
    if (!graph) return;

    const passes = graph.listPasses();
    const postPass = passes.find((p) => p.name === 'post-effect-0');
    expect(postPass).toBeDefined();
    if (!postPass) return;

    // No depth read declared -> pass does NOT gain a spurious depth dependency.
    expect(postPass.reads).not.toContain('depth');
  });
});
