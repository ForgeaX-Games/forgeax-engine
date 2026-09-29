import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type Buffer,
  type ComputePipeline,
  type RenderPipeline,
  type RhiCommandEncoder,
  RhiError,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureGpuProgramDescriptor } from '../features/prepared-gpu-work';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureGraphBufferState } from '../features/render-graph-resources';
import { createRenderFeatureTarget } from '../features/targets';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';

describe('RenderFeature persistent GPU work', () => {
  it('reuses compiled programs across playback names while keeping binding references distinct', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const modules = vi.fn(() => ok(shader));
    const pipelines = vi.spyOn(device, 'createComputePipeline');
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: modules }),
    });
    const descriptor = { wgsl: 'synthetic', entryPoints: ['simulate'] };
    const references = new Set<object>();
    for (let cycle = 0; cycle < 16; cycle++) {
      const session = owner.beginFeature('forgeax.vfx-render.gpu-particles', 0);
      references.add(session.prepareProgram(`player.g-${cycle}`, descriptor).unwrap());
      for (const lease of session.commitFrame()) lease.release().unwrap();
    }
    expect(references.size).toBe(16);
    expect(modules).toHaveBeenCalledTimes(1);
    expect(pipelines).toHaveBeenCalledTimes(1);
    const changed = owner.beginFeature('forgeax.vfx-render.gpu-particles', 0);
    changed.prepareProgram('different-program', { ...descriptor, wgsl: 'different' }).unwrap();
    expect(modules).toHaveBeenCalledTimes(2);
    owner
      .beginFeature('forgeax.vfx-render.gpu-particles', 1)
      .prepareProgram('recovered-program', descriptor)
      .unwrap();
    expect(modules).toHaveBeenCalledTimes(3);
    owner.dispose().unwrap();
  });

  it('bounds retained code and separates entry points and binding layouts', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const modules = vi.fn(() => ok(shader));
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: modules }),
    });
    const descriptor = { wgsl: 'synthetic', entryPoints: ['simulate'] };
    const session = owner.beginFeature('test', 0);
    session.prepareProgram('base', descriptor).unwrap();
    session.prepareProgram('entry', { ...descriptor, entryPoints: ['other'] }).unwrap();
    session
      .prepareProgram('layout', {
        ...descriptor,
        bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'uniform' } }] }],
      })
      .unwrap();
    expect(modules).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 64; index++) {
      session
        .prepareProgram(`variant-${index}`, { ...descriptor, wgsl: `variant-${index}` })
        .unwrap();
    }
    session.prepareProgram('evicted-base', descriptor).unwrap();
    expect(modules).toHaveBeenCalledTimes(68);
    session.prepareProgram('recent-variant', { ...descriptor, wgsl: 'variant-63' }).unwrap();
    expect(modules).toHaveBeenCalledTimes(68);
    owner.dispose().unwrap();
  });

  it('uses current material bindings when a compiled feature graph is reused', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<{
      encoder: RhiCommandEncoder;
      featureExecutions?: readonly import('../features/host').RenderFeaturePlanExecution[];
    }>();
    const target = graph
      .createTexture('color', {
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: 0x10,
      })
      .unwrap();
    const view = graph.view(target).unwrap();
    const pipeline = { kind: 'pipeline', generation: 1 } as const;
    const binding = { kind: 'bindings', generation: 1 } as const;
    const nextBinding = { kind: 'bindings', generation: 1 } as const;
    const descriptor = {
      attachments: {
        colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'clear', storeOp: 'store' }],
      },
      draws: [
        {
          kind: 'draw',
          pipeline,
          bindings: [binding],
          vertexLayout: 'none',
          vertexData: [],
          command: { vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        },
      ],
    } as const;
    const state = {
      capabilityAvailable: true,
      generation: 1,
      attachments: [{ resource: 'color', format: 'rgba8unorm' }],
      pipeline,
      pipelines: [pipeline],
      bindings: [binding],
      vertexData: [],
      indexData: [],
    } as const;
    const oldGroup = {} as BindGroup;
    const newGroup = {} as BindGroup;
    const snapshot = (group: BindGroup, activeBinding = binding) => ({
      generation: 1,
      resolve: (reference: object) =>
        reference === pipeline
          ? { kind: 'pipeline', reference: pipeline, handle: {} as RenderPipeline }
          : reference === activeBinding
            ? { kind: 'bindings', reference: activeBinding, handle: group }
            : undefined,
    });
    const raster = new RenderFeatureRasterGraphProjection(graph, () => ({ texture: target, view }));
    raster
      .addPass(
        'draw',
        'dynamic',
        0,
        descriptor as never,
        state as never,
        snapshot(oldGroup) as never,
      )
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const observed: BindGroup[] = [];
    const execute = (group: BindGroup, activeBinding = binding) => {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (input) => {
        const pass = begin(input);
        const set = pass.setBindGroup.bind(pass);
        pass.setBindGroup = (index, value, offsets) => {
          if (index === 0) observed.push(value);
          return set(index, value, offsets === undefined ? undefined : Array.from(offsets));
        };
        return pass;
      };
      compiled
        .execute({
          encoder,
          featureExecutions: [
            {
              featureIdentity: 'dynamic',
              order: 0,
              passes: [
                {
                  featureIdentity: 'dynamic',
                  order: 0,
                  name: 'draw',
                  graphics: {
                    ...descriptor,
                    draws: [{ ...descriptor.draws[0], bindings: [activeBinding] }],
                  } as never,
                  resolvedGraphics: snapshot(group, activeBinding) as never,
                },
              ],
            },
          ],
        })
        .unwrap();
      encoder.finish().unwrap();
    };
    execute(oldGroup);
    execute(newGroup, nextBinding);
    expect(observed).toEqual([oldGroup, newGroup]);
    await compiled.retire();
  });

  it('binds graph-owned sampled textures at execution instead of the preparation fallback', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const session = owner.beginFeature('sampled-compute', 0);
    const program = session
      .prepareProgram('sample', {
        wgsl: 'synthetic',
        entryPoints: ['sample'],
        bindings: [{ entries: [{ binding: 0, visibility: 4, texture: { sampleType: 'depth' } }] }],
      })
      .unwrap();
    const texture = device
      .createTexture({
        size: { width: 1, height: 1 },
        format: 'depth32float',
        usage: 0x04 | 0x10,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const fallback = device.createTextureView(texture, {}).unwrap();
    const reference = session
      .prepareTextureView(
        'depth',
        fallback,
        createRenderFeatureTarget({ kind: 'scene-depth', format: 'depth32float', sampleCount: 1 }),
      )
      .unwrap();
    const bindings = session
      .prepareBindings('bindings', {
        program,
        entries: [{ binding: 0, resource: { kind: 'texture-view', reference } }],
      })
      .unwrap();
    const work = session
      .resolveComputePass('sampled-compute', {
        program,
        bindings,
        dispatches: [{ entryPoint: 'sample', workgroups: [1] }],
      })
      .unwrap();
    expect(work.sampledTargets).toMatchObject([
      { kind: 'scene-depth', format: 'depth32float', sampleCount: 1 },
    ]);
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const depth = graph
      .createTexture('real-depth', {
        format: 'depth32float',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const view = graph.view(depth).unwrap();
    graph
      .addRasterPass('depth-producer', {
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0.25,
        },
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        encode: () => {},
      })
      .unwrap();
    const seen: unknown[] = [];
    const createBindGroup = device.createBindGroup.bind(device);
    device.createBindGroup = (descriptor) => {
      seen.push([...descriptor.entries][0]?.resource);
      return createBindGroup(descriptor);
    };
    const projection = new RenderFeatureComputeGraphProjection(graph, undefined, undefined, () => ({
      texture: depth,
      view,
    }));
    projection.addPass('sample', 'sampled-compute', 0, work).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes[1]?.dependencies).toEqual(['depth-producer']);
    compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toEqual({ kind: 'textureView', value: fallback });
    await compiled.retire();
    owner.dispose().unwrap();
  });
  it.each([
    [1, false],
    [4, false],
    [1, true],
    [4, true],
  ] as const)('projects compute and indirect raster consumption with %i samples, Standard lighting %s', async (sampleCount, standardLighting) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const indirectBuffer = device
      .createBuffer({ size: 16, usage: 0x0080 | 0x0100 | 0x0020 | 0x0008 })
      .unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const output = graph
      .createTexture('output', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const outputView = graph.view(output, { label: 'output.view' }).unwrap();
    const multisample =
      sampleCount === 1
        ? undefined
        : graph
            .createTexture('multisample', {
              format: 'rgba8unorm',
              size: { width: 1, height: 1 },
              sampleCount,
            })
            .unwrap();
    const multisampleView =
      multisample === undefined ? undefined : graph.view(multisample).unwrap();
    const buffers = createRenderFeatureGraphBufferState();
    const compute = new RenderFeatureComputeGraphProjection(graph, buffers);
    expect(
      compute.addPass('vfx.simulate-and-project', 'forgeax.vfx', 0, {
        buffers: [
          {
            name: 'draw-args',
            buffer: indirectBuffer,
            size: 16,
            physicalUsage: 0x0080 | 0x0100 | 0x0020 | 0x0008,
            access: 'storage-write',
          },
        ],
        dispatches: [
          {
            pipeline: {} as ComputePipeline,
            bindGroup: {} as BindGroup,
            workgroups: [1, 1, 1],
          },
        ],
      }).ok,
    ).toBe(true);

    const pipeline = { kind: 'pipeline', generation: 1 } as const;
    const binding = { kind: 'bindings', generation: 1 } as const;
    const vertices = { kind: 'vertex-data', generation: 1 } as const;
    const gpuArgs = { name: 'draw-args', generation: 1 } as never;
    const resources = new Map<object, PreparedGraphicsResolvedResource>([
      [
        pipeline,
        {
          kind: 'pipeline',
          reference: pipeline as never,
          handle: {} as RenderPipeline,
          standardLighting,
        },
      ],
      [
        vertices,
        {
          kind: 'vertex-data',
          reference: vertices as never,
          handle: indirectBuffer,
          size: 16,
          physicalUsage: 0x0080 | 0x0100 | 0x0020 | 0x0008,
        },
      ],
      [
        binding,
        {
          kind: 'bindings',
          reference: binding as never,
          handle: {} as BindGroup,
        },
      ],
    ]);
    const lightingGroup = {} as BindGroup;
    const raster = new RenderFeatureRasterGraphProjection(
      graph,
      () => ({
        texture: multisample ?? output,
        view: multisampleView ?? outputView,
        ...(multisampleView === undefined ? {} : { resolveTarget: outputView }),
      }),
      undefined,
      buffers,
      undefined,
      () => lightingGroup,
    );
    expect(
      raster.addPass(
        'vfx.draw',
        'vfx',
        0,
        {
          attachments: {
            colors: [
              {
                resource: 'output',
                format: 'rgba8unorm',
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          },
          draws: [
            {
              kind: 'draw-indirect',
              pipeline: pipeline as never,
              bindings: [binding as never],
              vertexData: [{ slot: 0, resource: vertices as never }],
              command: { buffer: gpuArgs, offset: 0 },
            },
          ],
        },
        {
          capabilityAvailable: true,
          generation: 1,
          attachments: [{ resource: 'output', format: 'rgba8unorm' }],
          pipeline: pipeline as never,
          pipelines: [pipeline as never],
          bindings: [binding as never],
          vertexData: [vertices as never],
          indexData: [],
        },
        {
          generation: 1,
          resolve: (reference) => resources.get(reference),
          resolveGpuBuffer: () => ({
            buffer: indirectBuffer as Buffer,
            size: 16,
            physicalUsage: 0x0080 | 0x0100 | 0x0020 | 0x0008,
          }),
        },
      ).ok,
    ).toBe(true);

    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes).toMatchObject([
      { name: 'vfx.simulate-and-project', kind: 'compute', dependencies: [] },
      { name: 'vfx.draw', kind: 'raster', dependencies: ['vfx.simulate-and-project'] },
    ]);
    const encoder = device.createCommandEncoder({ label: 'vfx-mixed-frame' }).unwrap();
    const bound: Array<{ index: number; group: BindGroup }> = [];
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (descriptor) => {
      const pass = begin(descriptor);
      const set = pass.setBindGroup.bind(pass);
      pass.setBindGroup = (index, group, offsets) => {
        bound.push({ index, group });
        return set(index, group, offsets === undefined ? undefined : Array.from(offsets));
      };
      return pass;
    };
    expect(compiled.execute({ encoder }).ok).toBe(true);
    expect(bound.filter((entry) => entry.index === 2)).toEqual(
      standardLighting ? [{ index: 2, group: lightingGroup }] : [],
    );
    expect(encoder.finish().ok).toBe(true);
  });

  it('classifies an asynchronous shader warmup as a next-frame retry', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: () =>
          err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'asynchronous shader compilation to finish',
              hint: 'retry on the next frame',
            }),
          ),
      }),
    });
    const resolver = owner.beginFeature('synthetic.gpu', 0);

    const prepared = resolver.prepareProgram('program', {
      wgsl: 'synthetic',
      entryPoints: ['simulate'],
    });

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.error).toMatchObject({
        code: 'render-feature-preparation-failed',
        detail: {
          operation: 'prepare-gpu-program',
          reason: 'rhi-not-available:retry on the next frame',
          recovery: 'next-frame',
        },
      });
    }
  });

  it('keeps immediate shader creation scoped to opted-in feature programs', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    let validatedCalls = 0;
    let immediateCalls = 0;
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: () => {
          validatedCalls += 1;
          return ok(shader);
        },
      }),
      getImmediateShaderModuleFactory: () => ({
        createShaderModule: () => {
          immediateCalls += 1;
          return ok(shader);
        },
      }),
    });

    const immediate = owner.beginFeature('synthetic.immediate', 0, 'immediate');
    expect(
      immediate.prepareProgram('immediate-program', {
        wgsl: 'synthetic',
        entryPoints: ['main'],
      }).ok,
    ).toBe(true);
    expect(immediateCalls).toBe(1);
    expect(validatedCalls).toBe(0);

    const validated = owner.beginFeature('synthetic.validated', 0);
    expect(
      validated.prepareProgram('validated-program', {
        wgsl: 'synthetic',
        entryPoints: ['main'],
      }).ok,
    ).toBe(true);
    expect(validatedCalls).toBe(1);
    expect(immediateCalls).toBe(1);
    expect(owner.dispose().ok).toBe(true);
  });

  it('reuses equivalent prepared programs and replaces changed descriptors across frames', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const resolver = owner.beginFeature('synthetic.program', 0);
    const descriptor = {
      wgsl: 'synthetic',
      entryPoints: ['simulate'],
      bindings: [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x4,
              buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
            },
          ],
        },
      ],
    } satisfies RenderFeatureGpuProgramDescriptor;
    const first = resolver.prepareProgram('program', descriptor).unwrap();
    const equivalent = resolver.prepareProgram('program', {
      wgsl: 'synthetic',
      entryPoints: ['simulate'],
      bindings: [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x4,
              buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
            },
          ],
        },
      ],
    });
    expect(equivalent).toMatchObject({ ok: true, value: first });

    resolver.commitFrame();
    resolver.beginFrame();
    const firstBinding = descriptor.bindings[0];
    if (firstBinding === undefined) throw new Error('fixture missing binding');
    const firstEntry = firstBinding.entries[0];
    if (firstEntry === undefined) throw new Error('fixture missing binding entry');
    const mutableEntry = firstEntry as { visibility: number };
    mutableEntry.visibility = 0x1;
    const changed = resolver.prepareProgram('program', descriptor);
    expect(changed.ok).toBe(true);
    expect(changed.unwrap()).not.toBe(first);
    expect(owner.dispose().ok).toBe(true);
  });

  it('records compute against persistent storage and releases it once', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const resolver = owner.beginFeature('synthetic.gpu', 4);
    const program = resolver
      .prepareProgram('program', {
        wgsl: 'synthetic',
        entryPoints: ['simulate', 'compact'],
        bindings: [
          {
            entries: [
              {
                binding: 0,
                visibility: 0x4,
                buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
              },
              {
                binding: 1,
                visibility: 0x4,
                buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
              },
            ],
          },
        ],
      })
      .unwrap();
    const storage = resolver
      .prepareBuffer('particles', {
        size: 4096,
        usage: ['storage', 'vertex'],
        data: new Uint32Array([1, 2, 3, 4]),
      })
      .unwrap();
    const indirect = resolver
      .prepareBuffer('indirect', {
        size: 20,
        usage: ['storage', 'indirect'],
        data: new Uint32Array([6, 0, 0, 0, 0]),
      })
      .unwrap();
    const dispatchArgs = resolver
      .prepareBuffer('dispatch-args', {
        size: 12,
        usage: ['indirect'],
        data: new Uint32Array([1, 1, 1]),
      })
      .unwrap();
    const bindings = resolver
      .prepareBindings('bindings', {
        program,
        entries: [
          { binding: 0, buffer: storage },
          { binding: 1, buffer: indirect },
        ],
      })
      .unwrap();
    const computeDescriptor = {
      program,
      bindings,
      dispatches: [
        { entryPoint: 'simulate', workgroups: [16] as const },
        { entryPoint: 'compact', workgroups: [1] as const },
        { entryPoint: 'simulate', indirect: { buffer: dispatchArgs, offset: 0 } },
      ],
    } as const;
    const missingUsage = resolver.resolveComputePass('synthetic.gpu', {
      program,
      bindings,
      dispatches: [{ entryPoint: 'simulate', indirect: { buffer: storage, offset: 0 } }],
    });
    expect(missingUsage.ok).toBe(false);
    if (!missingUsage.ok && missingUsage.error.code === 'render-feature-preparation-failed') {
      expect(missingUsage.error.detail.reason).toBe('indirect-dispatch-invalid');
    }
    const outOfBounds = resolver.resolveComputePass('synthetic.gpu', {
      program,
      bindings,
      dispatches: [{ entryPoint: 'simulate', indirect: { buffer: dispatchArgs, offset: 4 } }],
    });
    expect(outOfBounds.ok).toBe(false);
    if (!outOfBounds.ok && outOfBounds.error.code === 'render-feature-preparation-failed') {
      expect(outOfBounds.error.detail.reason).toBe('indirect-dispatch-invalid');
    }
    const work = resolver.resolveComputePass('synthetic.gpu', computeDescriptor).unwrap();
    expect(work.buffers.map((buffer) => [buffer.name, buffer.access])).toEqual([
      ['particles', 'storage-read-write'],
      ['indirect', 'storage-read-write'],
      ['dispatch-args', 'indirect-read'],
    ]);
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const projection = new RenderFeatureComputeGraphProjection(graph);
    expect(projection.addPass('synthetic.gpu.compute', 'synthetic.gpu', 0, work).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes[0]).toMatchObject({
      name: 'synthetic.gpu.compute',
      kind: 'compute',
      accesses: [
        { resource: 'synthetic.gpu.compute.particles', usage: 'storage-read-write' },
        { resource: 'synthetic.gpu.compute.indirect', usage: 'storage-read-write' },
        { resource: 'synthetic.gpu.compute.dispatch-args', usage: 'indirect-read' },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-feature-frame' }).unwrap();
    expect(compiled.execute({ encoder }).ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);

    expect(resolver.resolveBuffer(storage)).toBeDefined();
    expect(resolver.resolveBuffer(indirect)).toBeDefined();
    expect(resolver.resolveBuffer(dispatchArgs)).toBeDefined();
    expect(resolver.commitFrame()).toEqual([]);

    resolver.beginFrame();
    expect(resolver.retainBindings([bindings]).ok).toBe(true);
    expect(resolver.resolveComputePass('synthetic.gpu', computeDescriptor).ok).toBe(true);
    expect(resolver.commitFrame()).toEqual([]);

    resolver.beginFrame();
    const retired = resolver.commitFrame();
    expect(retired).toHaveLength(1);
    expect(retired[0]?.release().ok).toBe(true);
    expect(resolver.resolveBuffer(storage)).toBeUndefined();
    // A non-VFX feature retires all three resource kinds together.  The
    // binding/program indexes must be invalidated at the same boundary as the
    // buffer; otherwise a stale compute descriptor can revive work that now
    // references a destroyed buffer.
    expect(resolver.retainBindings([bindings]).ok).toBe(false);
    expect(resolver.resolveComputePass('synthetic.gpu', computeDescriptor).ok).toBe(false);
    expect(retired[0]?.release().ok).toBe(true);
    expect(retired[0]?.release().ok).toBe(true);
    expect(resolver.retainBindings([bindings]).ok).toBe(false);
    expect(resolver.resolveComputePass('synthetic.gpu', computeDescriptor).ok).toBe(false);

    resolver.beginFrame();
    const replacementProgram = resolver
      .prepareProgram('program', {
        wgsl: 'synthetic',
        entryPoints: ['simulate', 'compact'],
        bindings: [
          {
            entries: [
              {
                binding: 0,
                visibility: 0x4,
                buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
              },
              {
                binding: 1,
                visibility: 0x4,
                buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
              },
            ],
          },
        ],
      })
      .unwrap();
    const replacementStorage = resolver
      .prepareBuffer('particles', {
        size: 4096,
        usage: ['storage', 'vertex'],
        data: new Uint32Array([5, 6, 7, 8]),
      })
      .unwrap();
    const replacementIndirect = resolver
      .prepareBuffer('indirect', {
        size: 20,
        usage: ['storage', 'indirect'],
        data: new Uint32Array([6, 0, 0, 0, 0]),
      })
      .unwrap();
    const replacementBindings = resolver
      .prepareBindings('bindings', {
        program: replacementProgram,
        entries: [
          { binding: 0, buffer: replacementStorage },
          { binding: 1, buffer: replacementIndirect },
        ],
      })
      .unwrap();
    expect(replacementProgram).not.toBe(program);
    expect(replacementBindings).not.toBe(bindings);
    expect(resolver.retainBindings([bindings]).ok).toBe(false);
    expect(resolver.dispose().ok).toBe(true);
    expect(resolver.dispose().ok).toBe(true);
  });

  it('parks short-lived VFX queue slots and revives the same allocation', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok({} as never) }),
    });
    const session = owner.beginFeature('forgeax.vfx-render.gpu-particles', 0);
    const first = session
      .prepareBuffer('queued-slot', { size: 16, usage: ['storage'], data: new Uint32Array([1]) })
      .unwrap();
    expect(session.commitFrame()).toEqual([]);

    // One missing fixed tick parks the slot instead of retiring its physical
    // buffer. Re-publishing the same named slot must revive the exact ref.
    session.beginFrame();
    expect(session.commitFrame()).toEqual([]);
    session.beginFrame();
    const revived = session
      .prepareBuffer('queued-slot', { size: 16, usage: ['storage'], data: new Uint32Array([2]) })
      .unwrap();
    expect(revived).toBe(first);
    expect(session.resolveBuffer(first)).toBeDefined();
    expect(session.commitFrame()).toEqual([]);

    // Parking is bounded. After the window, the old allocation is retired via
    // the normal lease path and cannot be resolved by a stale reference.
    let retired = [] as ReturnType<typeof session.commitFrame>;
    for (let index = 0; index < 9; index += 1) {
      session.beginFrame();
      retired = session.commitFrame();
    }
    expect(retired).toHaveLength(1);
    expect(retired[0]?.release().ok).toBe(true);
    expect(session.resolveBuffer(first)).toBeUndefined();
    expect(owner.dispose().ok).toBe(true);
  });
});
