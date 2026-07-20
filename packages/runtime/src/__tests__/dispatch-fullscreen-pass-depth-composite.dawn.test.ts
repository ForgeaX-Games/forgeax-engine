// dispatch-fullscreen-pass-depth-composite.dawn.test.ts -
// feat-20260702-postprocess-camera-depth-read M3 / w8 (TDD RED).
//
// Spy-based dawn integration test for dispatchFullscreenPass compositeOverSwapchain
// branch with depth reads. Registers a post-process with structured
// `reads: [{key:'depth', sampleType:'depth'}]` and verifies the
// createBindGroup entries include depthTexView@3 + depthSampler@4.
//
// RED phase: the dispatcher does NOT yet thread depth in the composite
// branch; bindGroupCreates entries only count 2-3 (color + sampler [+ params]),
// not the 5 expected for depth. The test is written to verify the full
// 5-entry shape; assertions fail until w11 (impl: composite depth threading)
// is committed.
//
// Pattern mirrors the existing dispatch-fullscreen-pass-composite-swapchain.dawn.test.ts
// spy model, with additions:
//   (a) lookupPostProcess returns entry with structured depth reads + params
//   (b) frameState.perFrameGraph with getColorTargetTexture returning a mock depth tex
//   (c) createTextureView returning a mock depth-only view on aspect:'depth-only'
//   (d) createBindGroup spy asserts entry count == 5 and bindings @3/@4

import { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { addFullscreenPass } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';

interface BindGroupEntry {
  readonly binding: number;
  readonly resource: { readonly kind: string; readonly value: unknown };
}

interface Spy {
  readonly bindGroupCreates: { readonly entries: readonly BindGroupEntry[] }[];
  readonly beginRenderPassCalls: { readonly view: unknown }[];
  readonly copyCalls: { readonly src: unknown; readonly dst: unknown }[];
  readonly createdViewsFrom: unknown[];
  drawCalls: number;
}

type ExecuteWithResolve = (c: unknown, r: { resolve: (n: string) => unknown }) => void;

function findPassExecute(
  graph: RenderGraph<RenderPipelineContext>,
  passName: string,
): ExecuteWithResolve | undefined {
  const passes = (
    graph as unknown as {
      passes: {
        list(): readonly { name: string; descriptor: { execute?: ExecuteWithResolve } }[];
      };
    }
  ).passes.list();
  return passes.find((p) => p.name === passName)?.descriptor.execute;
}

function makeSpyCtx(opts: {
  lookup: (id: string) => PostProcessShaderEntry | undefined;
  currentTexture: unknown;
  storageView: unknown;
  depthTex: unknown;
  depthOnlyView: unknown;
  paramsBuffer: unknown;
}): { ctx: RenderPipelineContext; spy: Spy } {
  const spy: Spy = {
    bindGroupCreates: [],
    beginRenderPassCalls: [],
    copyCalls: [],
    createdViewsFrom: [],
    drawCalls: 0,
  };

  const passEncoder = {
    setPipeline(_p: unknown): void {},
    setBindGroup(_slot: number, _bg: unknown): void {},
    draw(): void {
      spy.drawCalls += 1;
    },
    end(): void {},
  };

  const mockGraph = {
    getColorTargetTexture: (key: string) => (key === 'depth' ? opts.depthTex : undefined),
  };

  const ctx = {
    runtime: {
      lookupPostProcess: opts.lookup,
      getPostProcessPipeline: (_id: string, _bgl: unknown, _format: string) => ({
        __pipeline: true,
      }),
      getPostProcessParamsBuffer: (_id: string) => opts.paramsBuffer,
      device: {
        createBindGroupLayout: (_d: unknown) => ({ ok: true, value: { __bgl: true } }),
        createSampler: (_d: unknown) => ({ ok: true, value: { __sampler: true } }),
        createBindGroup: (desc: { readonly entries: readonly BindGroupEntry[] }) => {
          spy.bindGroupCreates.push({ entries: desc.entries });
          return { ok: true, value: { __bg: true } };
        },
        createTextureView: (tex: unknown, desc: { readonly aspect?: string }) => {
          spy.createdViewsFrom.push({ tex, desc });
          if (desc.aspect === 'depth-only') return { ok: true, value: opts.depthOnlyView };
          return { ok: true, value: opts.storageView };
        },
        queue: {
          writeBuffer: (_buf: unknown, _offset: number, _data: Uint8Array) => ({ ok: true }),
        },
      },
      errorRegistry: { fire: (_e: unknown) => undefined },
    },
    pipelineState: { format: 'bgra8unorm', colorAttachmentFormat: 'bgra8unorm-srgb' },
    currentTexture: opts.currentTexture,
    targetW: 64,
    targetH: 64,
    view: { __swapchainSrgbView: true },
    encoder: {
      copyTextureToTexture: (src: { texture: unknown }, dst: { texture: unknown }) => {
        spy.copyCalls.push({ src: src.texture, dst: dst.texture });
      },
      beginRenderPass: (desc: { colorAttachments: readonly { view: unknown }[] }) => {
        spy.beginRenderPassCalls.push({ view: desc.colorAttachments[0]?.view });
        return passEncoder;
      },
    },
    postProcessParams: new Map<string, Uint8Array>([['test::depth-overlay', new Uint8Array(16)]]),
    frameState: { perFrameGraph: mockGraph },
  } as unknown as RenderPipelineContext;
  return { ctx, spy };
}

describe('feat-20260702 M3 w8: dispatchFullscreenPass compositeOverSwapchain depth binding (RED)', () => {
  it('composite path with depth reads binds 5 entries (depthTexView@3 + depthSampler@4)', () => {
    const swapTex = { __swapTexture: true };
    const scratchTex = { __scratchTex: true };
    const scratchView = { __scratchView: true };
    const storageView = { __nonSrgbStorageView: true };
    const depthTex = { __depthTex: true };
    const depthOnlyView = { __depthOnlyView: true };
    const paramsBuffer = { __paramsUBO: true };

    const entry: PostProcessShaderEntry = {
      source: 'fn vs_main(){} fn fs_main(){}',
      reads: [{ key: 'depth', sampleType: 'depth' }],
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
    };

    const { ctx, spy } = makeSpyCtx({
      lookup: (id: string) => (id === 'test::depth-overlay' ? entry : undefined),
      currentTexture: swapTex,
      storageView,
      depthTex,
      depthOnlyView,
      paramsBuffer,
    });

    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('scratch', { format: 'bgra8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'post-effect-0', {
      shader: 'test::depth-overlay',
      color: 'scratch',
      compositeOverSwapchain: true,
    });

    const execute = findPassExecute(graph, 'post-effect-0');
    expect(execute).toBeDefined();
    if (!execute) return;

    const resolveCtx = {
      resolve: (n: string) =>
        n === 'scratch::tex' ? scratchTex : n === 'scratch' ? scratchView : undefined,
    };
    execute(ctx, resolveCtx);

    // (a) copy swap-chain -> scratch still fires (color copy path unchanged).
    expect(spy.copyCalls.length).toBe(1);
    expect(spy.copyCalls[0]?.src).toBe(swapTex);
    expect(spy.copyCalls[0]?.dst).toBe(scratchTex);

    // (b) bind-group entries: 5 (color@0 + sampler@1 + params@2 + depthTex@3 + depthSampler@4).
    const entries = spy.bindGroupCreates[0]?.entries;
    expect(entries).toBeDefined();
    if (!entries) return;

    // RED: the dispatcher currently does not thread depth, so entry count is 3
    // (no depth). After w11 impl, this assertion passes with 5.
    expect(entries.length).toBe(5);

    // Binding 0 = scene color textureView (scratchView).
    const e0 = entries.find((e) => e.binding === 0);
    expect(e0?.resource.kind).toBe('textureView');
    expect(e0?.resource.value).toBe(scratchView);

    // Binding 1 = sampler.
    const e1 = entries.find((e) => e.binding === 1);
    expect(e1?.resource.kind).toBe('sampler');

    // Binding 2 = params buffer.
    const e2 = entries.find((e) => e.binding === 2);
    expect(e2?.resource.kind).toBe('buffer');

    // Binding 3 = depth textureView (depth-only).
    const e3 = entries.find((e) => e.binding === 3);
    expect(e3?.resource.kind).toBe('textureView');
    expect(e3?.resource.value).toBe(depthOnlyView);

    // Binding 4 = depth sampler (non-filtering).
    const e4 = entries.find((e) => e.binding === 4);
    expect(e4?.resource.kind).toBe('sampler');

    // draw fired.
    expect(spy.drawCalls).toBe(1);
  });

  it('depth key not in graph -> throws fullscreen-input-not-found', () => {
    const swapTex = { __swapTexture: true };
    const scratchTex = { __scratchTex: true };
    const scratchView = { __scratchView: true };
    const paramsBuffer = { __paramsUBO: true };

    const entry: PostProcessShaderEntry = {
      source: 'fn vs_main(){} fn fs_main(){}',
      reads: [{ key: 'depth', sampleType: 'depth' }],
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
    };

    const { ctx, spy } = makeSpyCtx({
      lookup: (id: string) => (id === 'test::depth-throw' ? entry : undefined),
      currentTexture: swapTex,
      storageView: { __storage: true },
      // depthTex is undefined — getColorTargetTexture returns undefined.
      depthTex: undefined as unknown as Record<string, unknown>,
      depthOnlyView: { __dummy: true },
      paramsBuffer,
    });

    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('scratch', { format: 'bgra8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'post-effect-0', {
      shader: 'test::depth-throw',
      color: 'scratch',
      compositeOverSwapchain: true,
    });

    const execute = findPassExecute(graph, 'post-effect-0');
    if (!execute) return;

    const resolveCtx = {
      resolve: (n: string) =>
        n === 'scratch::tex' ? scratchTex : n === 'scratch' ? scratchView : undefined,
    };

    // RED: dispatcher currently ignores depth — no throw on missing depth key.
    // After w11 impl, this throws fullscreen-input-not-found.
    let caught: unknown = null;
    try {
      execute(ctx, resolveCtx);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const err = caught as { code?: string; detail?: { readsKey?: string; passName?: string } };
    expect(err.code).toBe('fullscreen-input-not-found');
    expect(err.detail?.readsKey).toBe('depth');
    expect(err.detail?.passName).toBe('post-effect-0');

    // fail-fast: no draw before throw.
    expect(spy.drawCalls).toBe(0);
  });
});
