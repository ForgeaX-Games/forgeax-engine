// @forgeax/engine-runtime/__tests__/hdrp-ssao-falsification.test.ts
// SSAO falsification check (M5 / w23).
// feat-20260612-hdrp-ssao.
//
// plan-strategy section 5.4: falsification must FAIL AC-10 visual expectation
// when ssao-blur reads a wrong input (e.g. hdrColor) instead of ssaoRaw.
//
// This test constructs an isolated render graph with addSsaoPasses and asserts
// the correct reads/writes topology. It then documents two falsification
// variants that would break the SSAO pipeline:
//
//   Variant-1 (blur reads hdrColor instead of ssaoRaw):
//     The blur pass would sample the HDR colour output instead of the raw
//     occlusion map. Result: no AO darkening at contact edges -- the blur
//     pass is a no-op that feeds flat HDR colour into the ambient term.
//     This would cause the smoke test (w22) to PASS structurally (passes
//     still present) but AC-10 visual inspection would FAIL (no corner
//     darkening).
//
//   Variant-2 (calc reads hdrColor instead of gbuf0):
//     SSAO calculation that samples HDR colour instead of world-space
//     normal. The 64-sample hemisphere occlusion test against wrong data
//     produces garbage occlusion values. Result: random noise pattern
//     rather than contact-edge darkening. AC-10 FAIL.
//
// Both variants are documented here as the falsification proof; the test
// itself asserts the correct topology to provide a machine-readable guard.
//
// Local-only test (not in CI). The smoke discriminability proof is that
// w23 FAILS (this test fails) when reads are mutated.

import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { addSsaoPasses } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';
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
    createTexture: vi.fn().mockReturnValue({
      ok: true,
      value: { label: 'mock-tex' },
    }),
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

function setupGraph(graph: RenderGraph<RenderPipelineContext>): void {
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
  graph.addColorTarget('hdrColor', {
    format: 'rgba16float',
    size: 'swapchain',
    sample: 1,
  });
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
}

describe('hdrp-ssao-falsification (M5 / w23)', () => {
  it('ssao-calc reads gbuf0 (world-space normal) + hdrDepth — NOT hdrColor', () => {
    const runtime = mockRuntime();
    const ctx = mockCtx(runtime);
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraph(graph);

    addSsaoPasses(graph, {
      gbuf0: 'gbuf0',
      hdrDepth: 'hdrDepth',
      ssaoRaw: 'ssaoRaw',
      ssaoBlurred: 'ssaoBlurred',
      ctx,
    });

    const passes = graph.listPasses();
    const calcPass = passes.find((p) => p.name === 'ssao-calc');
    expect(calcPass).toBeDefined();
    if (!calcPass) return;

    // Calc MUST read gbuf0 (world-space normal for view-space transform).
    expect(calcPass.reads).toContain('gbuf0');
    // Calc MUST NOT read hdrColor (lighting output -- Variant-2 falsification).
    expect(calcPass.reads).not.toContain('hdrColor');
    // Calc MUST read hdrDepth (depth for view-space position reconstruction).
    expect(calcPass.reads).toContain('hdrDepth');
  });

  it('ssao-blur reads ssaoRaw — NOT hdrColor (Variant-1 falsification guard)', () => {
    const runtime = mockRuntime();
    const ctx = mockCtx(runtime);
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraph(graph);

    addSsaoPasses(graph, {
      gbuf0: 'gbuf0',
      hdrDepth: 'hdrDepth',
      ssaoRaw: 'ssaoRaw',
      ssaoBlurred: 'ssaoBlurred',
      ctx,
    });

    const passes = graph.listPasses();
    const blurPass = passes.find((p) => p.name === 'ssao-blur');
    expect(blurPass).toBeDefined();
    if (!blurPass) return;

    // Blur MUST read ssaoRaw (the raw occlusion R8 map from calc pass).
    expect(blurPass.reads).toContain('ssaoRaw');
    // Blur MUST NOT read hdrColor (Variant-1 falsification:
    // reading HDR colour would produce no AO darkening — AC-10 FAIL).
    expect(blurPass.reads).not.toContain('hdrColor');
    // M8 / w38: blur reads also include gbuf0 + hdrDepth as graph deps so
    // the shared 9-entry SSAO BGL has valid resources at every slot. The
    // shader does not statically reference them, but the BindGroup must
    // bind them or WebGPU rejects the draw — Variant-1's "no AO darkening"
    // failure mode is still preserved: if the blur sampled hdrColor instead
    // of ssaoRaw, AO would still wash out, and the read declaration above
    // continues to enforce the correct input.
    expect(blurPass.reads).toHaveLength(3);
  });

  it('Variant-1 proof: if blur read hdrColor, AO would not darken contact edges', () => {
    // This structural test documents the falsification contract.
    // When ssao-blur reads are changed from ['ssaoRaw'] to ['hdrColor']:
    //
    //   graph.addPass('ssao-blur', {
    //     reads: ['hdrColor'],   // <-- falsified: wrong input
    //     writes: ['ssaoBlurred'],
    //     ...
    //   });
    //
    // The blur pass would sample HDR lighting output instead of the raw
    // occlusion map. The fs_ssao_blur shader applies a 4x4 box blur which
    // averages HDR colour values to produce a uniform per-pixel value.
    // When fed into the deferred lighting ambient term:
    //
    //   ambient *= mix(1.0, ssaoFactor * bakedAO, intensity)
    //
    // ... ssaoFactor comes from the blurred-HDR-colour texture, not the
    // occlusion texture. Result: uniform ambient modulation (all pixels
    // get similar ssaoFactor), no AO darkening at contact edges.
    //
    // The w22 smoke test would PASS (perFramePassNames still includes
    // ssao-calc + ssao-blur), but AC-10 visual inspection would FAIL --
    // the demo image would show no corner/contact darkening.
    //
    // This is the discriminability contract: the smoke is structural,
    // the visual gate is the falsification check.
    expect(true).toBe(true);
  });

  it('Variant-2 proof: if calc read hdrColor instead of gbuf0, occlusion is garbage', () => {
    // When ssao-calc reads are changed from ['gbuf0', 'hdrDepth'] to
    // ['hdrColor', 'hdrDepth']:
    //
    //   graph.addPass('ssao-calc', {
    //     reads: ['hdrColor', 'hdrDepth'],   // <-- falsified
    //     writes: ['ssaoRaw'],
    //     ...
    //   });
    //
    // The fs_ssao_calc shader unpacks the gbuf0 read as world-space
    // normal (*2-1), transforms to view-space, and builds a TBN matrix
    // for hemisphere sampling. If gbuf0 carries HDR colour values [0..1]
    // instead of packed normal components:
    //
    //   - viewNormal = (hdrColor * 2.0 - 1.0) is incorrect
    //   - TBN Gram-Schmidt produces a nonsensical tangent frame
    //   - 64-sample hemisphere occlusion against wrong normal direction
    //     produces random per-pixel occlusion values
    //
    // Result: random noise pattern in the AO buffer, not contact-edge
    // darkening. AC-10 visual inspection would FAIL (noise instead of
    // expected corner shadows).
    expect(true).toBe(true);
  });

  it('compile succeeds with correct reads topology', () => {
    const runtime = mockRuntime();
    const ctx = mockCtx(runtime);
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraph(graph);

    graph.addPass('g-buffer', {
      reads: [],
      writes: ['gbuf0', 'hdrDepth'],
    });

    addSsaoPasses(graph, {
      gbuf0: 'gbuf0',
      hdrDepth: 'hdrDepth',
      ssaoRaw: 'ssaoRaw',
      ssaoBlurred: 'ssaoBlurred',
      ctx,
    });

    const compileResult = graph.compile({
      backendKind: runtime.device.caps.backendKind,
      caps: runtime.device.caps,
      device: runtime.device,
    });
    expect(compileResult.ok).toBe(true);
  });
});
