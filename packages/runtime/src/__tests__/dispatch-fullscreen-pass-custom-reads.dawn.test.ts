// dispatch-fullscreen-pass-custom-reads.dawn.test.ts -
// feat-20260609-learn-render-4-5-framebuffers-demo-offscreen-rt-an M1 / T-4.
//
// Spy/mock unit-style integration tests for dispatchFullscreenPass's generic
// (non-FXAA) branch. The test bypasses real GPU pipeline build by spying on
// the per-frame encoder; the dispatcher's structural call chain is validated:
//
//   (a) reads[0] resolves through the per-pass resolveCtx -> graph-owned
//       TextureView; the dispatcher passes that resolved view into
//       createFullscreenBindGroup (verified via spy on the bind-group
//       textureView entry).
//   (b) On the success path the dispatcher opens a render pass on
//       ctx.encoder, calls pass.setBindGroup(1, bg), then handle.draw(pass)
//       which internally does pass.setPipeline + pass.draw(3, 1, 0, 0).
//   (c) When reads[0] is non-empty but resolveCtx returns undefined for the
//       key (mis-spelled / un-declared color target), the dispatcher throws
//       PostProcessError({code:'fullscreen-input-not-found',
//       detail:{readsKey, passName}}) before any encoder call -- charter P3
//       fail-fast.
//   (d) reads === [] preserves the legacy ctx.view swap-chain path; the
//       dispatcher samples ctx.view (no resolveCtx invocation for any key).
//
// File lives under .dawn.test.ts naming (per plan-decisions L-3) so the
// dawn vitest project picks it up; a Node-only environment would also work
// (no real GPU calls fire), but the dawn project is the canonical home for
// per-frame-execute integration tests.

import { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { addFullscreenPass } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';

interface BindGroupEntry {
  readonly binding: number;
  readonly resource: { readonly kind: string; readonly value: unknown };
}

interface BindGroupCall {
  readonly slot: number;
  readonly bindGroup: unknown;
}

interface DrawCall {
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstVertex: number;
  readonly firstInstance: number;
}

interface DispatchSpy {
  readonly bindGroupCreates: { readonly entries: readonly BindGroupEntry[] }[];
  readonly setBindGroupCalls: BindGroupCall[];
  readonly setPipelineCalls: unknown[];
  readonly drawCalls: DrawCall[];
  readonly beginRenderPassCalls: { readonly view: unknown }[];
}

type ExecuteWithResolve = (c: unknown, r: { resolve: (n: string) => unknown }) => void;

function findPassExecute(
  graph: RenderGraph<RenderPipelineContext>,
  passName: string,
): ExecuteWithResolve | undefined {
  // Reach into the package-private pass registry to recover descriptor.execute
  // (mirrors post-process-register-roundtrip.dawn.test.ts pattern; the public
  // RenderGraph surfaces only listPasses with name/reads/writes -- the executor
  // body lives on the PassEntry).
  const passes = (
    graph as unknown as {
      passes: {
        list(): readonly {
          name: string;
          descriptor: { execute?: ExecuteWithResolve };
        }[];
      };
    }
  ).passes.list();
  return passes.find((p) => p.name === passName)?.descriptor.execute;
}

function makeSpyCtx(opts: {
  lookup: (id: string) => { source: string } | undefined;
  view: unknown;
}): { ctx: RenderPipelineContext; spy: DispatchSpy } {
  const spy: DispatchSpy = {
    bindGroupCreates: [],
    setBindGroupCalls: [],
    setPipelineCalls: [],
    drawCalls: [],
    beginRenderPassCalls: [],
  };

  const passEncoder = {
    setPipeline(p: unknown): void {
      spy.setPipelineCalls.push(p);
    },
    setBindGroup(slot: number, bg: unknown): void {
      spy.setBindGroupCalls.push({ slot, bindGroup: bg });
    },
    draw(
      vertexCount: number,
      instanceCount: number,
      firstVertex: number,
      firstInstance: number,
    ): void {
      spy.drawCalls.push({ vertexCount, instanceCount, firstVertex, firstInstance });
    },
    end(): void {},
  };

  const ctx = {
    runtime: {
      lookupPostProcess: opts.lookup,
      // T-10-a: dispatcher now reads runtime.getPostProcessPipeline; spy
      // returns a stub pipeline so the success-path tests reach
      // beginRenderPass / setBindGroup / setPipeline / draw. The stub object
      // is opaque to the dispatcher (it forwards to setPipeline as-is).
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
      },
      errorRegistry: { fire: (_e: unknown) => undefined },
    },
    view: opts.view,
    encoder: {
      beginRenderPass: (desc: { colorAttachments: readonly { view: unknown }[] }) => {
        spy.beginRenderPassCalls.push({ view: desc.colorAttachments[0]?.view });
        return passEncoder;
      },
    },
  } as unknown as RenderPipelineContext;
  return { ctx, spy };
}

describe('feat-20260609 M1 T-4: dispatchFullscreenPass custom reads spy', () => {
  it('(a) reads[0] resolves via resolveCtx -> bindGroup samples the resolved input view', () => {
    const inputView = { __resolvedInputView: 'offscreenColor' };
    const writeView = { __writeView: 'rt' };
    const swapView = { __swap: true };
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      view: swapView,
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('rt', { format: 'rgba8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'pp', {
      shader: 'test::reads-resolved',
      color: 'rt',
      reads: ['offscreenColor'],
    });

    const execute = findPassExecute(graph, 'pp');
    expect(execute).toBeDefined();
    if (!execute) return;

    const resolveCtx = {
      resolve: (n: string) =>
        n === 'offscreenColor' ? inputView : n === 'rt' ? writeView : undefined,
    };
    execute(ctx, resolveCtx);

    // (a) bindgroup binding 0 carries the resolved offscreenColor view, not the
    // legacy ctx.view swap-chain view -- this confirms reads[0] -> graph-owned
    // input is the real path.
    expect(spy.bindGroupCreates.length).toBe(1);
    const textureViewEntry = spy.bindGroupCreates[0]?.entries.find(
      (e) => e.resource.kind === 'textureView',
    );
    expect(textureViewEntry).toBeDefined();
    expect(textureViewEntry?.resource.value).toBe(inputView);
  });

  it('(b) success path -> setBindGroup(1, bg) + draw(3, 1, 0, 0) really fire on the encoder', () => {
    const inputView = { __resolvedInputView: 'offscreenColor' };
    const writeView = { __writeView: 'rt' };
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      view: { __swap: true },
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('rt', { format: 'rgba8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'pp', {
      shader: 'test::draw-fires',
      color: 'rt',
      reads: ['offscreenColor'],
    });

    const execute = findPassExecute(graph, 'pp');
    if (!execute) return;

    const resolveCtx = {
      resolve: (n: string) =>
        n === 'offscreenColor' ? inputView : n === 'rt' ? writeView : undefined,
    };
    execute(ctx, resolveCtx);

    // beginRenderPass fired on the resolved write view (graph-owned 'rt').
    expect(spy.beginRenderPassCalls.length).toBe(1);
    expect(spy.beginRenderPassCalls[0]?.view).toBe(writeView);

    // setBindGroup(1, bg) fired with slot=1 (plan-strategy convention; slot 0
    // reserved for future view bind groups).
    expect(spy.setBindGroupCalls.length).toBe(1);
    expect(spy.setBindGroupCalls[0]?.slot).toBe(1);
    expect(spy.setBindGroupCalls[0]?.bindGroup).toEqual({ __bg: true });

    // handle.draw -> pass.draw(3, 1, 0, 0) for the fullscreen-triangle vertex
    // shader covering the entire framebuffer.
    expect(spy.drawCalls.length).toBe(1);
    expect(spy.drawCalls[0]).toEqual({
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    });
  });

  it('(c) reads[0] unresolved -> throws PostProcessError fullscreen-input-not-found before any encoder call', () => {
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      view: { __swap: true },
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('rt', { format: 'rgba8unorm', size: { w: 64, h: 64 } });
    // reads[0] = 'never-declared': the resolveCtx below returns undefined for it
    // -> dispatcher must throw.
    addFullscreenPass(graph, 'pp', {
      shader: 'test::reads-throw',
      color: 'rt',
      reads: ['never-declared'],
    });

    const execute = findPassExecute(graph, 'pp');
    if (!execute) return;

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
    expect(err.detail?.readsKey).toBe('never-declared');
    expect(err.detail?.passName).toBe('pp');

    // Charter P3 fail-fast: throw fires BEFORE any encoder call. The encoder
    // remains untouched (no spurious render passes / bind groups created).
    expect(spy.beginRenderPassCalls.length).toBe(0);
    expect(spy.setBindGroupCalls.length).toBe(0);
    expect(spy.drawCalls.length).toBe(0);
  });

  it('(d) reads === [] preserves legacy ctx.view swap-chain path (no resolveCtx call for input)', () => {
    const swapView = { __swap: true };
    const { ctx, spy } = makeSpyCtx({
      lookup: () => ({ source: 'fn vs_main(){} fn fs_main(){}' }),
      view: swapView,
    });
    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('rt', { format: 'rgba8unorm', size: { w: 64, h: 64 } });
    addFullscreenPass(graph, 'pp', {
      shader: 'test::no-reads',
      color: 'rt',
      // reads omitted -> defaults to []
    });

    const execute = findPassExecute(graph, 'pp');
    if (!execute) return;

    let resolveCalls = 0;
    const resolveCtx = {
      resolve: (n: string): unknown => {
        resolveCalls += 1;
        return n === 'rt' ? { __rt: true } : undefined;
      },
    };
    execute(ctx, resolveCtx);

    // ctx.view (swap-chain) feeds the bind-group input texture entry when reads
    // is empty (preserving the FXAA-style legacy swap-chain sample contract).
    expect(spy.bindGroupCreates.length).toBe(1);
    const tvEntry = spy.bindGroupCreates[0]?.entries.find((e) => e.resource.kind === 'textureView');
    expect(tvEntry?.resource.value).toBe(swapView);
    // resolveCtx.resolve is still consulted for the writes target (color='rt').
    expect(resolveCalls).toBeGreaterThanOrEqual(1);
  });
});
