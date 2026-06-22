// dispatch-fullscreen-pass-params.unit.test.ts -
// feat-20260621-fullscreen-post-process-per-frame-uniform-params-l M-A2 / w6 + w7.
//
// Spy/mock unit tests for the per-frame params UBO channel wired into
// dispatchFullscreenPass's generic (non-FXAA) branch. No real GPU: the device,
// queue, and per-pass resolveCtx are spied so the structural call chain is
// validated:
//
//   w6 (entry.params !== undefined, the active params channel):
//     (1) the per-frame `data` is looked up from ctx.postProcessParams by
//         shader id and written via queue.writeBuffer(ubo, 0, data).
//     (2) buildFullscreenPostProcessPass yields a 3-entry input BGL
//         (texture@0 + sampler@1 + buffer@2) -- asserted through
//         createFullscreenBindGroup's entries (binding 2 present).
//     (3) the pipeline layout stays 2 BGLs ([emptyPostProcessBgl(group0),
//         bgl(group1)]) -- params binding goes INTO group(1), q3=B.
//
//   w7 (zero-regression + fail-fast):
//     (1) entry.params === undefined -> 2-entry BGL (no binding 2, no
//         writeBuffer) -- the 6 existing param-less consumers degrade
//         byte-identically (R-A7).
//     (2) register byteSize < 16 -> PostProcessError{code:'params-size-mismatch'}.
//     (3) register defaultValue.length !== byteSize -> same code.
//     (4) write-path data.byteLength !== registered byteSize ->
//         PostProcessError{code:'params-update-size-mismatch'} (detail carries
//         byteSize / actualLength).

import { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from '../pipeline-spec';
import { PostProcessError } from '../post-process-errors';
import { addFullscreenPass } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';

interface BindGroupEntry {
  readonly binding: number;
  readonly resource: { readonly kind: string; readonly value: unknown };
}

interface WriteBufferCall {
  readonly buffer: unknown;
  readonly offset: number;
  readonly data: unknown;
}

interface DispatchSpy {
  readonly bindGroupCreates: { readonly entries: readonly BindGroupEntry[] }[];
  readonly writeBufferCalls: WriteBufferCall[];
  readonly setBindGroupCalls: { slot: number; bindGroup: unknown }[];
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
        list(): readonly {
          name: string;
          descriptor: { execute?: ExecuteWithResolve };
        }[];
      };
    }
  ).passes.list();
  return passes.find((p) => p.name === passName)?.descriptor.execute;
}

interface PostProcessEntryStub {
  readonly source: string;
  readonly params?: { readonly byteSize: number; readonly defaultValue: Uint8Array } | undefined;
}

function makeSpyCtx(opts: {
  entry: PostProcessEntryStub;
  paramsBuffer?: unknown;
  snapshot?: ReadonlyMap<string, Uint8Array>;
  view: unknown;
}): { ctx: RenderPipelineContext; spy: DispatchSpy } {
  const spy: DispatchSpy = {
    bindGroupCreates: [],
    writeBufferCalls: [],
    setBindGroupCalls: [],
    drawCalls: 0,
  };

  const passEncoder = {
    setPipeline(_p: unknown): void {},
    setBindGroup(slot: number, bg: unknown): void {
      spy.setBindGroupCalls.push({ slot, bindGroup: bg });
    },
    draw(_v: number, _i: number, _fv: number, _fi: number): void {
      spy.drawCalls += 1;
    },
    end(): void {},
  };

  const ctx = {
    runtime: {
      lookupPostProcess: (_id: string) => opts.entry,
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
        queue: {
          writeBuffer: (buffer: unknown, offset: number, data: unknown) => {
            spy.writeBufferCalls.push({ buffer, offset, data });
            return { ok: true, value: undefined };
          },
        },
      },
      errorRegistry: { fire: (_e: unknown) => undefined },
    },
    view: opts.view,
    postProcessParams: opts.snapshot ?? new Map<string, Uint8Array>(),
    encoder: {
      beginRenderPass: (_desc: unknown) => passEncoder,
    },
  } as unknown as RenderPipelineContext;
  return { ctx, spy };
}

const SHADER_ID = 'test::params-channel';

function buildAndExecute(opts: {
  entry: PostProcessEntryStub;
  paramsBuffer?: unknown;
  snapshot?: ReadonlyMap<string, Uint8Array>;
}): { spy: DispatchSpy; threw: unknown } {
  const inputView = { __input: true };
  const writeView = { __write: true };
  const { ctx, spy } = makeSpyCtx({
    entry: opts.entry,
    ...(opts.paramsBuffer !== undefined ? { paramsBuffer: opts.paramsBuffer } : {}),
    ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
    view: { __swap: true },
  });
  const graph = new RenderGraph<RenderPipelineContext>();
  graph.addColorTarget('rt', { format: 'rgba8unorm', size: { w: 64, h: 64 } });
  addFullscreenPass(graph, 'pp', {
    shader: SHADER_ID,
    color: 'rt',
    reads: ['offscreenColor'],
  });
  const execute = findPassExecute(graph, 'pp');
  if (!execute) throw new Error('pass execute not found');
  const resolveCtx = {
    resolve: (n: string) =>
      n === 'offscreenColor' ? inputView : n === 'rt' ? writeView : undefined,
  };
  let threw: unknown = null;
  try {
    execute(ctx, resolveCtx);
  } catch (e) {
    threw = e;
  }
  return { spy, threw };
}

describe('M-A2 w6: dispatch 3-entry BGL + per-frame writeBuffer (params channel active)', () => {
  it('looks up data from snapshot and writes it to the per-id UBO', () => {
    const ubo = { __ubo: true };
    const data = Float32Array.of(2.5, 1, 0, 0); // 16 bytes
    const snapshot = new Map<string, Uint8Array>([[SHADER_ID, new Uint8Array(data.buffer)]]);
    const { spy, threw } = buildAndExecute({
      entry: { source: 'fn fs(){}', params: { byteSize: 16, defaultValue: new Uint8Array(16) } },
      paramsBuffer: ubo,
      snapshot,
    });
    expect(threw).toBeNull();
    expect(spy.writeBufferCalls.length).toBe(1);
    expect(spy.writeBufferCalls[0]?.buffer).toBe(ubo);
    expect(spy.writeBufferCalls[0]?.offset).toBe(0);
  });

  it('createFullscreenBindGroup includes binding 2 (the params buffer)', () => {
    const ubo = { __ubo: true };
    const snapshot = new Map<string, Uint8Array>([[SHADER_ID, new Uint8Array(16)]]);
    const { spy } = buildAndExecute({
      entry: { source: 'fn fs(){}', params: { byteSize: 16, defaultValue: new Uint8Array(16) } },
      paramsBuffer: ubo,
      snapshot,
    });
    expect(spy.bindGroupCreates.length).toBe(1);
    const entries = spy.bindGroupCreates[0]?.entries ?? [];
    const binding2 = entries.find((e) => e.binding === 2);
    expect(binding2).toBeDefined();
    expect(binding2?.resource.kind).toBe('buffer');
    // RHI GPUBufferBinding shape: value is `{ buffer: <handle> }`, not the raw
    // handle (dawn rejects the raw handle — see createFullscreenBindGroup).
    expect((binding2?.resource.value as { buffer: unknown }).buffer).toBe(ubo);
  });

  it('pipeline layout stays 2 BGLs: the fullscreen-post-with-params BGL has 3 entries', () => {
    // The params binding goes INTO group(1) (q3=B): the dispatcher composes
    // ONE bind group at slot 1 (group(0) stays the empty post-process BGL).
    const ubo = { __ubo: true };
    const snapshot = new Map<string, Uint8Array>([[SHADER_ID, new Uint8Array(16)]]);
    const { spy } = buildAndExecute({
      entry: { source: 'fn fs(){}', params: { byteSize: 16, defaultValue: new Uint8Array(16) } },
      paramsBuffer: ubo,
      snapshot,
    });
    // Exactly one setBindGroup, at slot 1 (group(1)); no extra group is added.
    expect(spy.setBindGroupCalls.length).toBe(1);
    expect(spy.setBindGroupCalls[0]?.slot).toBe(1);

    // BGL descriptor: 'fullscreen-post-with-params' is 3-entry.
    const spec: PipelineSpec = {
      shader: { id: '', passKind: 'forward', variantSet: undefined },
      attachments: {
        colorFormats: ['rgba16float'] as readonly GPUTextureFormat[],
        depthFormat: undefined,
        sampleCount: 1,
      },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    } as PipelineSpec;
    const desc = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post-with-params' });
    expect(desc.entries.length).toBe(3);
    const bufferEntry = desc.entries.find((e) => e.binding === 2);
    expect(bufferEntry?.buffer?.type).toBe('uniform');
  });
});

describe('M-A2 w7: param-less degrade + register / write fail-fast', () => {
  it('(1) entry.params === undefined -> 2-entry BGL (no binding 2, no writeBuffer)', () => {
    const { spy, threw } = buildAndExecute({
      entry: { source: 'fn fs(){}' }, // no params -> param-less consumer
    });
    expect(threw).toBeNull();
    expect(spy.writeBufferCalls.length).toBe(0);
    expect(spy.bindGroupCreates.length).toBe(1);
    const entries = spy.bindGroupCreates[0]?.entries ?? [];
    expect(entries.find((e) => e.binding === 2)).toBeUndefined();
    // 2-entry BGL descriptor unchanged.
    const spec: PipelineSpec = {
      shader: { id: '', passKind: 'forward', variantSet: undefined },
      attachments: {
        colorFormats: ['rgba16float'] as readonly GPUTextureFormat[],
        depthFormat: undefined,
        sampleCount: 1,
      },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    } as PipelineSpec;
    const desc = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
    expect(desc.entries.length).toBe(2);
  });

  it('(4) write-path data.byteLength !== byteSize -> params-update-size-mismatch', () => {
    const ubo = { __ubo: true };
    // Registered byteSize 16, but snapshot data is 12 bytes -> mismatch.
    const snapshot = new Map<string, Uint8Array>([[SHADER_ID, new Uint8Array(12)]]);
    const { spy, threw } = buildAndExecute({
      entry: { source: 'fn fs(){}', params: { byteSize: 16, defaultValue: new Uint8Array(16) } },
      paramsBuffer: ubo,
      snapshot,
    });
    expect(threw).not.toBeNull();
    const err = threw as { code?: string; detail?: { byteSize?: number; actualLength?: number } };
    expect(err.code).toBe('params-update-size-mismatch');
    expect(err.detail?.byteSize).toBe(16);
    expect(err.detail?.actualLength).toBe(12);
    // Fail-fast before writeBuffer.
    expect(spy.writeBufferCalls.length).toBe(0);
  });
});

// w7 register fail-fast (2)+(3): the register guard from M-A1 / w5
// (render-system.ts postProcess.register) throws PostProcessError with code
// 'params-size-mismatch' whose hint carries the min-16B guidance. This asserts
// the error surface register relies on (.code / .hint / .detail) is intact and
// AI-actionable. The LIVE throw path (real register() rejecting byteSize < 16
// and defaultValue-length mismatch) is exercised against a real Renderer in
// post-process-register-roundtrip.dawn.test.ts.
describe('M-A2 w7: register-time byteSize fail-fast (params-size-mismatch)', () => {
  it('(2) byteSize < 16 -> params-size-mismatch hint includes min 16B', () => {
    const err = new PostProcessError({
      code: 'params-size-mismatch',
      detail: { byteSize: 8, actualLength: 8 },
    });
    expect(err.code).toBe('params-size-mismatch');
    expect(err.hint).toContain('16');
    expect(err.detail.byteSize).toBe(8);
  });

  it('(3) defaultValue.length !== byteSize -> params-size-mismatch detail carries both', () => {
    const err = new PostProcessError({
      code: 'params-size-mismatch',
      detail: { byteSize: 16, actualLength: 12 },
    });
    expect(err.code).toBe('params-size-mismatch');
    expect(err.detail.actualLength).toBe(12);
  });
});
