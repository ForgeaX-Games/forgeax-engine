// dispatch-fullscreen-pass-composite-swapchain.dawn.test.ts -
// feat-20260621-learn-render-5-3-production-shadow-demos M4' (post-URP hook).
//
// Spy/mock unit-style tests for dispatchFullscreenPass's compositeOverSwapchain
// branch -- the generalisation of the built-in FXAA copy idiom that lets a
// built-in pipeline layer a registered effect over its FINAL swap-chain image
// WITHOUT replacing the pipeline (and dropping its shadow / tonemap passes).
//
// The branch must:
//   (a) copy the current swap-chain (ctx.currentTexture) into the `color`
//       scratch texture (resolved via `${color}::tex`) BEFORE sampling, so the
//       effect reads the already-composited image.
//   (b) feed the scratch's TextureView (resolved via `${color}`) into the bind
//       group input -- NOT ctx.view.
//   (c) write through the swap-chain NON-srgb storage view
//       (device.createTextureView(ctx.currentTexture)) -- R-COLORSPACE: the
//       scratch holds an already-sRGB-encoded copy, so the srgb view would
//       double-encode (mirrors recordFxaaPass).
//   (d) throw PostProcessError{fullscreen-input-not-found} when the scratch
//       texture is unresolved (charter P3 fail-fast), before any encoder call.

import { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { addFullscreenPass } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';

interface BindGroupEntry {
  readonly binding: number;
  readonly resource: { readonly kind: string; readonly value: unknown };
}

interface CopyCall {
  readonly src: unknown;
  readonly dst: unknown;
}

interface Spy {
  readonly bindGroupCreates: { readonly entries: readonly BindGroupEntry[] }[];
  readonly beginRenderPassCalls: { readonly view: unknown }[];
  readonly copyCalls: CopyCall[];
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
  lookup: (id: string) => { source: string } | undefined;
  currentTexture: unknown;
  storageView: unknown;
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

  const ctx = {
    runtime: {
      lookupPostProcess: opts.lookup,
      getPostProcessPipeline: (_id: string, _bgl: unknown, _format: string) => ({
        __pipeline: true,
      }),
      device: {
        createBindGroupLayout: (_d: unknown) => ({ ok: true, value: { __bgl: true } }),
        createSampler: (_d: unknown) => ({ ok: true, value: { __sampler: true } }),
        createBindGroup: (desc: { readonly entries: readonly BindGroupEntry[] }) => {
          spy.bindGroupCreates.push({ entries: desc.entries });
          return { ok: true, value: { __bg: true } };
        },
        createTextureView: (tex: unknown, _d: unknown) => {
          spy.createdViewsFrom.push(tex);
          return { ok: true, value: opts.storageView };
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
  } as unknown as RenderPipelineContext;
  return { ctx, spy };
}

describe('feat-20260621 M4′: dispatchFullscreenPass compositeOverSwapchain', () => {
  it('(a)(b)(c) copies swap-chain -> scratch, samples scratch view, writes swap-chain storage view', () => {
    const swapTex = { __swapTexture: true };
    const scratchTex = { __scratchTex: true };
    const scratchView = { __scratchView: true };
    const storageView = { __nonSrgbStorageView: true };
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      currentTexture: swapTex,
      storageView,
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('scratch', { format: 'bgra8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'post-effect-0', {
      shader: 'test::composite',
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

    // (a) copy swap-chain -> scratch fired exactly once, src=swapTex dst=scratchTex.
    expect(spy.copyCalls.length).toBe(1);
    expect(spy.copyCalls[0]?.src).toBe(swapTex);
    expect(spy.copyCalls[0]?.dst).toBe(scratchTex);

    // (b) bind-group input texture = the scratch view (the copied final image),
    // NOT ctx.view.
    const tvEntry = spy.bindGroupCreates[0]?.entries.find((e) => e.resource.kind === 'textureView');
    expect(tvEntry?.resource.value).toBe(scratchView);

    // (c) write target = the swap-chain non-srgb storage view, created from
    // ctx.currentTexture (R-COLORSPACE), not the srgb ctx.view.
    expect(spy.createdViewsFrom).toContain(swapTex);
    expect(spy.beginRenderPassCalls[0]?.view).toBe(storageView);

    // fullscreen draw fired.
    expect(spy.drawCalls).toBe(1);
  });

  it('(d) unresolved scratch texture -> throws fullscreen-input-not-found before any encoder call', () => {
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      currentTexture: { __swapTexture: true },
      storageView: { __storage: true },
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('scratch', { format: 'bgra8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'post-effect-0', {
      shader: 'test::composite-throw',
      color: 'scratch',
      compositeOverSwapchain: true,
    });

    const execute = findPassExecute(graph, 'post-effect-0');
    if (!execute) return;

    // resolveCtx returns undefined for scratch::tex (not yet compiled) -> throw.
    const resolveCtx = { resolve: (_n: string) => undefined };
    let caught: unknown = null;
    try {
      execute(ctx, resolveCtx);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const err = caught as { code?: string; detail?: { readsKey?: string; passName?: string } };
    expect(err.code).toBe('fullscreen-input-not-found');
    expect(err.detail?.readsKey).toBe('scratch');
    expect(err.detail?.passName).toBe('post-effect-0');

    // Fail-fast: no copy, no render pass before the throw.
    expect(spy.copyCalls.length).toBe(0);
    expect(spy.beginRenderPassCalls.length).toBe(0);
  });
});
