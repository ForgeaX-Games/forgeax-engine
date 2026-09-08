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
import { describe, expect, it } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureGraphBufferState } from '../features/render-graph-resources';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';

describe('RenderFeature persistent GPU work', () => {
  it('projects compute output and indirect raster consumption into one typed graph', async () => {
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
    const raster = new RenderFeatureRasterGraphProjection(
      graph,
      () => ({ texture: output, view: outputView }),
      undefined,
      buffers,
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
    expect(compiled.execute({ encoder }).ok).toBe(true);
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
    expect(resolver.retireUntouched()).toEqual([]);

    resolver.beginFrame();
    expect(resolver.retainBindings([bindings]).ok).toBe(true);
    expect(resolver.resolveComputePass('synthetic.gpu', computeDescriptor).ok).toBe(true);
    expect(resolver.retireUntouched()).toEqual([]);

    resolver.beginFrame();
    const retired = resolver.retireUntouched();
    expect(retired).toHaveLength(1);
    expect(resolver.resolveBuffer(storage)).toBeUndefined();
    expect(retired[0]?.release().ok).toBe(true);
    expect(retired[0]?.release().ok).toBe(true);
    expect(resolver.dispose().ok).toBe(true);
    expect(resolver.dispose().ok).toBe(true);
  });
});
