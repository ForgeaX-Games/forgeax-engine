import type {
  RenderBundle,
  RenderPipelineDescriptor,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { RenderBundleCache, type RenderBundleCounters } from '../render-bundle-cache';

async function device(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw result.error;
  return result.value;
}
function pass(device: RhiDevice) {
  const command = device.createCommandEncoder();
  if (!command.ok) throw command.error;
  return command.value.beginRenderPass({ colorAttachments: [] });
}
function buffer(device: RhiDevice) {
  const result = device.createBuffer({ size: 512, usage: 0x58 });
  if (!result.ok) throw result.error;
  return result.value;
}

/** Observe the Null backend at execution and reduce it to effective work.
 * Every draw carries the pipeline, bind groups, vertex/index buffers and
 * dynamic state it executes with; bundles start from empty binding state and
 * clear it afterwards (WebGPU semantics). Two sequences that bind the same
 * state for every draw in the same order are equivalent, even when a bundle
 * prelude re-sets state a direct pass inherited.
 */
function observeCommands(d: RhiDevice) {
  type Command = { method: string; args: unknown[] };
  type Event = { method: string; args: unknown[]; state?: string };
  const recorded = new WeakMap<RenderBundle, Command[]>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const canonical = (arg: unknown): unknown => {
    if (Array.isArray(arg)) return arg.map(canonical);
    if (typeof arg !== 'object' || arg === null) return arg;
    if (!ids.has(arg)) ids.set(arg, nextId++);
    return `resource:${ids.get(arg)}`;
  };
  interface Binding {
    pipeline?: unknown;
    groups: Map<unknown, unknown>;
    vertex: Map<unknown, unknown>;
    index?: unknown;
  }
  const emptyBinding = (): Binding => ({ groups: new Map(), vertex: new Map() });
  const simulate = (
    command: Command,
    binding: Binding,
    dynamic: Map<string, unknown>,
    events: Event[],
  ) => {
    const { method, args } = command;
    switch (method) {
      case 'setPipeline':
        binding.pipeline = args[0];
        return;
      case 'setBindGroup':
        binding.groups.set(args[0], args.slice(1));
        return;
      case 'setVertexBuffer':
        binding.vertex.set(args[0], args.slice(1));
        return;
      case 'setIndexBuffer':
        binding.index = args;
        return;
      case 'setViewport':
      case 'setScissorRect':
      case 'setBlendConstant':
      case 'setStencilReference':
        dynamic.set(method, args);
        return;
      case 'draw':
      case 'drawIndexed':
      case 'drawIndirect':
      case 'drawIndexedIndirect':
        events.push({
          method,
          args,
          state: JSON.stringify([
            binding.pipeline,
            [...binding.groups].sort(),
            [...binding.vertex].sort(),
            binding.index,
            [...dynamic].sort(),
          ]),
        });
        return;
      default:
        events.push({ method, args });
    }
  };
  const capture = <T extends RhiRenderCommands>(
    target: T,
    onCommand: (command: Command) => void,
    onBundles?: (bundles: readonly RenderBundle[]) => void,
  ): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const method = Reflect.get(object, key, receiver);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          if (key === 'finish') return Reflect.apply(method, object, args);
          if (key === 'executeBundles') {
            const handles = Array.from(args[0] as Iterable<RenderBundle>);
            const result = Reflect.apply(method, object, [handles]);
            if (!result.ok) throw result.error;
            onBundles?.(handles);
            return result;
          }
          if (key === 'setBindGroup') {
            const offsets = args[2];
            args = [
              args[0],
              args[1],
              offsets instanceof Uint32Array
                ? Array.from(
                    offsets.subarray(args[3] as number, (args[3] as number) + (args[4] as number)),
                  )
                : (offsets ?? []),
            ];
          }
          onCommand({ method: String(key), args: args.map(canonical) });
          return Reflect.apply(method, object, args);
        };
      },
    });
  const create = d.createRenderBundleEncoder.bind(d);
  const builds = vi.spyOn(d, 'createRenderBundleEncoder').mockImplementation((desc) => {
    const result = create(desc);
    if (!result.ok) return result;
    const commands: Command[] = [];
    const encoder = capture(result.value, (command) => commands.push(command));
    const finish = encoder.finish.bind(encoder);
    encoder.finish = () => {
      const finished = finish();
      if (finished.ok) recorded.set(finished.value, commands);
      return finished;
    };
    return ok(encoder);
  });
  return {
    builds,
    frame(cache: RenderBundleCache | undefined, record: (p: RhiRenderPassEncoder) => void) {
      const events: Event[] = [];
      let binding = emptyBinding();
      const dynamic = new Map<string, unknown>();
      const p = capture(
        pass(d),
        (command) => simulate(command, binding, dynamic, events),
        (bundles) => {
          for (const bundle of bundles) {
            const commands = recorded.get(bundle);
            if (!commands) throw new Error('Unobserved bundle');
            const bundleBinding = emptyBinding();
            for (const command of commands) simulate(command, bundleBinding, dynamic, events);
          }
          binding = emptyBinding();
        },
      );
      if (cache) cache.encode(d, p, record);
      else record(p);
      p.end();
      return events;
    },
  };
}

describe('scene pass render bundle cache', () => {
  it.each([
    'create',
    'finish',
    'execute',
  ] as const)('recovers after a %s failure during admission', async (stage) => {
    const d = await device();
    const cache = new RenderBundleCache({ colorFormats: [] });
    const count = 3;
    const record = (target: RhiRenderPassEncoder) => target.draw(count);
    const create = d.createRenderBundleEncoder.bind(d);
    const replacement = vi.spyOn(d, 'createRenderBundleEncoder').mockImplementationOnce((desc) => {
      if (stage === 'create') throw new Error('injected failure');
      const result = create(desc);
      if (result.ok && stage === 'finish')
        vi.spyOn(result.value, 'finish').mockImplementationOnce(() => {
          throw new Error('injected failure');
        });
      return result;
    });
    const failedPass = pass(d);
    if (stage === 'execute')
      vi.spyOn(failedPass, 'executeBundles').mockImplementationOnce(() => {
        throw new Error('injected failure');
      });
    cache.encode(d, pass(d), record);
    expect(() => cache.encode(d, failedPass, record)).toThrow('injected failure');
    const freshPass = pass(d);
    const execute = vi.spyOn(freshPass, 'executeBundles');
    cache.encode(d, freshPass, record);
    expect(execute).not.toHaveBeenCalled();
    cache.encode(d, pass(d), record);
    expect(replacement).toHaveBeenCalledTimes(2);
  });

  it('matches direct execution through 1,000 changing frames across eight independent passes', async () => {
    const d = await device();
    const observer = observeCommands(d);
    const caches = Array.from({ length: 8 }, () => new RenderBundleCache({ colorFormats: [] }));
    const buffers = Array.from({ length: 4 }, () => buffer(d));
    const layout = d.createBindGroupLayout({ entries: [] });
    if (!layout.ok) throw layout.error;
    const group = d.createBindGroup({ layout: layout.value, entries: [] });
    if (!group.ok) throw group.error;
    const pipelines = [0, 1].map(() => {
      const created = d.createRenderPipeline({} as RenderPipelineDescriptor);
      if (!created.ok) throw created.error;
      return created.value;
    });
    const offsets = new Uint32Array(65_536);
    let seed = 0x5eeda11;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let frame = 0; frame < 1_000; frame++) {
      for (let index = 0; index < caches.length; index++) {
        const cache = caches[index];
        if (!cache) throw new Error('Missing pass cache');
        // Pass 0 is always stable; others mix growing, shrinking, empty,
        // resource/argument/order changes and short periods of stability.
        const revision = index === 0 ? 0 : Math.floor(frame / (index + 1));
        const count = index === 0 ? 8 : frame % 31 === 0 ? 0 : (revision * 7) % 33;
        const vertex = buffers[revision % buffers.length];
        if (!vertex) throw new Error('Missing vertex buffer');
        const offset = (random() % 64) * 256;
        const record = (p: RhiRenderPassEncoder) => {
          p.setViewport(0, 0, 32, 32, 0, 1);
          p.setVertexBuffer(0, vertex, 0, 64);
          for (let draw = 0; draw < count; draw++) {
            const number = revision % 2 === 0 ? draw : count - draw - 1;
            // Batches: a pipeline switch splits segments; a stable prefix of
            // batches must keep its bundles while a later batch changes.
            if (draw % 3 === 0) {
              const pipeline = pipelines[(draw / 3 + (draw > count / 2 ? revision : 0)) % 2];
              if (pipeline) p.setPipeline(pipeline);
            }
            if (draw % 5 === 2) p.setIndexBuffer(vertex, 'uint16', draw * 2);
            offsets[32_768] = index === 0 ? 0 : offset;
            p.setBindGroup(0, group.value, offsets, 32_768, 1);
            offsets[32_768] = 123; // Must not mutate an already-recorded command.
            if (index === 7 && draw === 1) p.setScissorRect(number, 0, 8, 8);
            if (index === 6 && draw === 1) p.insertDebugMarker('fallback ordering');
            switch (number % 4) {
              case 0:
                p.draw(3, 1, 0, number);
                break;
              case 1:
                p.drawIndexed(3, 1, 0, 0, number);
                break;
              case 2:
                p.drawIndirect(vertex, number * 16);
                break;
              case 3:
                p.drawIndexedIndirect(vertex, number * 20);
                break;
            }
          }
        };
        expect(observer.frame(cache, record), `frame=${frame} pass=${index} seed=${seed}`).toEqual(
          observer.frame(undefined, record),
        );
      }
    }
    expect(observer.builds.mock.calls.length).toBeGreaterThan(0);
    // Replacing a compiled graph replaces only its pass-local cache.
    const stable = caches[0];
    if (!stable) throw new Error('Missing stable pass');
    const before = observer.builds.mock.calls.length;
    const record = (p: RhiRenderPassEncoder) => p.draw(3);
    for (let generation = 0; generation < 100; generation++) {
      const replaced = new RenderBundleCache({ colorFormats: [] });
      observer.frame(replaced, record);
      observer.frame(replaced, record);
    }
    expect(observer.builds.mock.calls.length).toBe(before + 100);
  }, 30_000);

  it('warms once, records once, and executes stable submissions without re-recording', async () => {
    const d = await device();
    const cache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    const record = (p: RhiRenderPassEncoder) => {
      p.draw(3);
      p.drawIndexed(6);
    };
    const passes = Array.from({ length: 60 }, () => pass(d));
    const executions = passes.map((p) => vi.spyOn(p, 'executeBundles'));
    for (const p of passes) {
      cache.encode(d, p, record);
      p.end();
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(executions.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(59);
    for (const p of passes) expect((p as unknown as { drawCount: number }).drawCount).toBe(2);
  });

  it('backs off after churn with a growing bypass, then re-admits stable work', async () => {
    const d = await device();
    const cache = new RenderBundleCache({ colorFormats: [] });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    const directFrames: number[] = [];
    const frame = (count: number, index: number) => {
      const target = pass(d);
      cache.encode(d, target, (encoder) => {
        if (encoder === target) directFrames.push(index);
        encoder.draw(count);
      });
    };

    frame(1, 0);
    frame(1, 1);
    expect(create).toHaveBeenCalledTimes(1);
    for (let index = 2; index < 16; index++) frame(index, index);
    // Four idle frames (2-5) bypass 4 frames; four more (10-13) bypass 8.
    expect(directFrames).toEqual([6, 7, 8, 9, 14, 15]);
    expect(create).toHaveBeenCalledTimes(1);

    for (let index = 16; index < 64; index++) frame(15, index);
    expect(directFrames).toEqual([6, 7, 8, 9, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the changed batch and counts one lookup per drawing segment', async () => {
    const d = await device();
    const pipelines = [0, 1, 2].map(() => {
      const created = d.createRenderPipeline({} as RenderPipelineDescriptor);
      if (!created.ok) throw created.error;
      return created.value;
    });
    const cache = new RenderBundleCache({ colorFormats: [] });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    const counters: RenderBundleCounters = { hits: 0, misses: 0 };
    let middle = 3;
    const frame = () => {
      const target = pass(d);
      const execute = vi.spyOn(target, 'executeBundles');
      cache.encode(
        d,
        target,
        (encoder) => {
          for (const [index, pipeline] of pipelines.entries()) {
            encoder.setPipeline(pipeline);
            encoder.draw(index === 1 ? middle : 3);
          }
        },
        counters,
      );
      return execute.mock.calls.map((call) => Array.from(call[0]).length);
    };
    frame();
    expect(counters).toEqual({ hits: 0, misses: 3 });
    frame();
    expect(create).toHaveBeenCalledTimes(3);
    expect(counters).toEqual({ hits: 0, misses: 6 });
    expect(frame()).toEqual([3]);
    expect(counters).toEqual({ hits: 3, misses: 6 });
    middle = 6;
    // The first and last batches keep their bundles around the direct middle batch.
    expect(frame()).toEqual([1, 1]);
    expect(counters).toEqual({ hits: 5, misses: 7 });
    expect(create).toHaveBeenCalledTimes(3);
    frame();
    expect(create).toHaveBeenCalledTimes(4);
    expect(frame()).toEqual([3]);
  });

  it.each([
    'handle',
    'offset',
    'count',
    'order',
    'removal',
  ] as const)('keeps buffer contents live, then re-records once after a %s change', async (change) => {
    const d = await device();
    const cache = new RenderBundleCache({ colorFormats: ['rgba8unorm'], sampleCount: 4 });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    let vertex = buffer(d);
    let offset = 0,
      count = 3,
      reverse = false,
      includeIndirect = true;
    const indirect = buffer(d);
    const record = (p: RhiRenderPassEncoder) => {
      p.setVertexBuffer(0, vertex, offset, 64);
      if (reverse) p.draw(count);
      if (includeIndirect) p.drawIndirect(indirect, offset);
      if (!reverse) p.draw(count);
    };
    const frame = () => cache.encode(d, pass(d), record);
    frame();
    frame();
    expect(create).toHaveBeenCalledTimes(1);
    expect(d.queue.writeBuffer(vertex, 0, new Float32Array(16)).ok).toBe(true);
    frame();
    expect(create).toHaveBeenCalledTimes(1);
    switch (change) {
      case 'handle':
        vertex = buffer(d);
        break;
      case 'offset':
        offset = 16;
        break;
      case 'count':
        count = 6;
        break;
      case 'order':
        reverse = true;
        break;
      case 'removal':
        includeIndirect = false;
        break;
    }
    frame();
    expect(create).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 70; attempt++) frame();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('copies dynamic offset slices and invalidates when their selected values change', async () => {
    const d = await device();
    const layout = d.createBindGroupLayout({ entries: [] });
    if (!layout.ok) throw layout.error;
    const group = d.createBindGroup({ layout: layout.value, entries: [] });
    if (!group.ok) throw group.error;
    const cache = new RenderBundleCache({ colorFormats: [] });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    const offsets = new Uint32Array([123, 256, 456]);
    const frame = () =>
      cache.encode(d, pass(d), (p) => {
        p.setBindGroup(0, group.value, offsets, 1, 1);
        p.draw(3);
      });
    frame();
    offsets[0] = 999;
    frame();
    expect(create).toHaveBeenCalledTimes(1);
    offsets[1] = 512;
    frame();
    expect(create).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 70; attempt++) frame();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reads only the selected offset slice, independent of the backing array size', async () => {
    const d = await device();
    const layout = d.createBindGroupLayout({ entries: [] });
    if (!layout.ok) throw layout.error;
    const group = d.createBindGroup({ layout: layout.value, entries: [] });
    if (!group.ok) throw group.error;
    const offsets = new Uint32Array(65_536);
    offsets[32_768] = 256;
    const iterate = vi.spyOn(offsets, Symbol.iterator).mockImplementation(() => {
      throw new Error('Unselected offset storage was enumerated');
    });
    const cache = new RenderBundleCache({ colorFormats: [] });
    for (let frame = 0; frame < 60; frame++) {
      const p = pass(d);
      cache.encode(d, p, (target) => {
        target.setBindGroup(0, group.value, offsets, 32_768, 1);
        target.draw(3);
      });
      p.end();
    }
    expect(iterate).not.toHaveBeenCalled();
  });

  it('preserves backend validation of out-of-range slices and clears the prior cache', async () => {
    const d = await device();
    const layout = d.createBindGroupLayout({ entries: [] });
    if (!layout.ok) throw layout.error;
    const group = d.createBindGroup({ layout: layout.value, entries: [] });
    if (!group.ok) throw group.error;
    const cache = new RenderBundleCache({ colorFormats: [] });
    const create = vi.spyOn(d, 'createRenderBundleEncoder');
    const record = (target: RhiRenderPassEncoder) => target.draw(3);
    cache.encode(d, pass(d), record);
    cache.encode(d, pass(d), record);
    const p = pass(d);
    const set = vi
      .spyOn(p, 'setBindGroup')
      .mockImplementation((_index, _group, offsets, start, length) => {
        if (offsets instanceof Uint32Array && (start ?? 0) + (length ?? 0) > offsets.length) {
          throw new RangeError('offset slice exceeds backing storage');
        }
      });
    const offsets = new Uint32Array([0]);
    expect(() =>
      cache.encode(d, p, (target) => target.setBindGroup(0, group.value, offsets, 1, 1)),
    ).toThrow('offset slice exceeds backing storage');
    expect(set).toHaveBeenCalledWith(0, group.value, offsets, 1, 1);
    cache.encode(d, pass(d), record);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('preserves mid-draw dynamic state order and never caches an occlusion region', async () => {
    const d = await device();
    const observer = observeCommands(d);
    const stencilCache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
    const occlusionCache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
    const occlusion: RenderBundleCounters = { hits: 0, misses: 0 };
    const stencil = (target: RhiRenderPassEncoder) => {
      target.setStencilReference(1);
      target.draw(3);
      target.setStencilReference(2);
      target.draw(4);
    };
    const query = (target: RhiRenderPassEncoder) => {
      target.beginOcclusionQuery(0);
      target.draw(3);
      target.endOcclusionQuery();
    };
    for (let frame = 0; frame < 3; frame++) {
      expect(observer.frame(stencilCache, stencil)).toEqual(observer.frame(undefined, stencil));
      const builds = observer.builds.mock.calls.length;
      occlusionCache.encode(d, pass(d), query, occlusion);
      expect(observer.builds.mock.calls.length).toBe(builds);
    }
    expect(observer.builds).toHaveBeenCalledTimes(2);
    expect(occlusion).toEqual({ hits: 0, misses: 0 });
  });

  it('drops failed and previous-device sequences instead of executing stale bundles', async () => {
    const a = await device(),
      b = await device();
    const cache = new RenderBundleCache({ colorFormats: [] });
    const createA = vi.spyOn(a, 'createRenderBundleEncoder'),
      createB = vi.spyOn(b, 'createRenderBundleEncoder');
    const record = (p: RhiRenderPassEncoder) => p.draw(3);
    cache.encode(a, pass(a), record);
    cache.encode(a, pass(a), record);
    expect(() =>
      cache.encode(a, pass(a), (p) => {
        p.draw(3);
        throw new Error('record failed');
      }),
    ).toThrow('record failed');
    cache.encode(a, pass(a), record);
    expect(createA).toHaveBeenCalledTimes(1);
    cache.encode(a, pass(a), record);
    expect(createA).toHaveBeenCalledTimes(2);
    cache.encode(b, pass(b), record);
    expect(createB).not.toHaveBeenCalled();
    cache.encode(b, pass(b), record);
    expect(createB).toHaveBeenCalledTimes(1);
  });
});
