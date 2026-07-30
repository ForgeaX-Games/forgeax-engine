import type { BindGroup, RenderPipeline } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsItem,
} from '../features/prepared-graphics-store';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolverInput,
} from '../prepare/prepared-graphics-resolver';

async function device() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap();
}

function resultMap(items: readonly PreparedGraphicsItem[]): Map<object, PreparedGraphicsItem> {
  return new Map(items.map((item) => [item.reference, item]));
}

function failure<T>(result: Result<T, unknown>): {
  readonly code: string;
  readonly detail?: { readonly reason: string };
} {
  if (result.ok) throw new Error('expected a resolver failure');
  return result.error as {
    readonly code: string;
    readonly detail?: { readonly reason: string };
  };
}

describe('prepared graphics resolver', () => {
  it('maps normalized operations to current-device handles without using refs as handles', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.feature', 7);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    const bindings = transaction.prepare('bindings', 'forward', {
      pipeline: pipeline.unwrap(),
      values: { tint: [1, 0, 0, 1] },
    });
    const vertex = transaction.prepare('vertex-data', 'triangle', {
      layout: 'position',
      data: new Float32Array([0, 1, 2]),
    });
    const index = transaction.prepare('index-data', 'triangle', {
      format: 'uint16',
      data: new Uint16Array([0, 1, 2]),
    });
    expect(transaction.commit().ok).toBe(true);

    const items = store.snapshot('resolver.feature').items;
    const lookup = resultMap(items);
    const shader = (
      await rhi.createShaderModule(currentDevice, { code: 'synthetic' })
    ).unwrap() as unknown as GPUShaderModule;
    const input: PreparedGraphicsResolverInput = {
      device: currentDevice,
      generation: 7,
      capabilityAvailable: true,
      lookup: (ref) => lookup.get(ref),
      resolvePipeline: () =>
        currentDevice.createRenderPipeline({
          layout: 'auto',
          vertex: { module: shader, entryPoint: 'main', buffers: [] },
          fragment: { module: shader, entryPoint: 'main', targets: [] },
        }) as Result<RenderPipeline, never>,
      resolveBindings: () => {
        const layout = currentDevice.createBindGroupLayout({ entries: [] }).unwrap();
        return currentDevice.createBindGroup({ layout, entries: [] }) as Result<BindGroup, never>;
      },
    };
    const resolver = createPreparedGraphicsResolver(input);
    const pipelineRef = pipeline.unwrap();
    const bindingsRef = bindings.unwrap();
    const vertexRef = vertex.unwrap();
    const indexRef = index.unwrap();
    const resolvedPipeline = resolver.resolve(pipelineRef);
    const resolvedBindings = resolver.resolve(bindingsRef);
    const resolvedVertex = resolver.resolve(vertexRef);
    const resolvedIndex = resolver.resolve(indexRef);

    expect(resolvedPipeline.ok).toBe(true);
    expect(resolvedBindings.ok).toBe(true);
    expect(resolvedVertex.ok).toBe(true);
    expect(resolvedIndex.ok).toBe(true);
    expect(resolvedPipeline.ok && resolvedPipeline.value.handle).not.toBe(pipelineRef);
    expect(resolvedBindings.ok && resolvedBindings.value.handle).not.toBe(bindingsRef);
    expect(resolvedVertex.ok && resolvedVertex.value.handle).not.toBe(vertexRef);
    expect(resolvedIndex.ok && resolvedIndex.value.handle).not.toBe(indexRef);
  });

  it('rejects capability, resolution, stale, and forged refs before record mutation', async () => {
    const currentDevice = await device();
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('resolver.failure', 3);
    const pipeline = transaction.prepare('pipeline', 'forward', {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    expect(transaction.commit().ok).toBe(true);
    const lookup = resultMap(store.snapshot('resolver.failure').items);
    let resolveCalls = 0;
    const base: PreparedGraphicsResolverInput = {
      device: currentDevice,
      generation: 3,
      capabilityAvailable: true,
      lookup: (ref) => lookup.get(ref),
      resolvePipeline: () => {
        resolveCalls += 1;
        return ok({} as RenderPipeline);
      },
      resolveBindings: () => ok({} as BindGroup),
    };

    const pipelineRef = pipeline.unwrap();
    const unavailable = createPreparedGraphicsResolver({
      ...base,
      capabilityAvailable: false,
    }).resolve(pipelineRef);
    expect(unavailable.ok).toBe(false);
    expect(failure(unavailable).code).toBe('render-feature-preparation-failed');
    expect(resolveCalls).toBe(0);

    const stale = createPreparedGraphicsResolver({ ...base, generation: 4 }).resolve(pipelineRef);
    expect(stale.ok).toBe(false);
    const staleError = failure(stale);
    expect(staleError.code).toBe('render-feature-prepared-state-mismatch');
    expect(staleError.detail?.reason).toBe('generation-mismatch');
    expect(resolveCalls).toBe(0);

    const forged = createPreparedGraphicsResolver(base).resolve({
      kind: 'pipeline',
      generation: 3,
    });
    expect(forged.ok).toBe(false);
    const forgedError = failure(forged);
    expect(forgedError.code).toBe('render-feature-prepared-state-mismatch');
    expect(forgedError.detail?.reason).toBe('missing-prepared-state');
    expect(resolveCalls).toBe(0);

    const failed = createPreparedGraphicsResolver({
      ...base,
      resolvePipeline: () => {
        resolveCalls += 1;
        return ok(undefined as never);
      },
    }).resolve(pipelineRef);
    expect(failed.ok).toBe(false);
    expect(failure(failed).code).toBe('render-feature-preparation-failed');
    expect(resolveCalls).toBe(1);
  });
});
