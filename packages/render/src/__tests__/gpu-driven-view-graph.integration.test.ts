import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type { RenderFrameState } from '../record/frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { ensureCompiledFrameGraph } from '../record/typed-frame-graph';
import type { RenderPipeline, RenderPipelineFrame } from '../render-pipeline';
import type {
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const material = {
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot;

function snapshot(entityKey: number): RenderableSnapshot {
  return {
    assetHandle: 3,
    transform: { world: new Float32Array(mat4.identity(mat4.create())) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
      },
    ],
  };
}

function preparedFrame(view: GpuDrivenView): PreparedGpuDrivenFrame {
  return {
    topologySignature: `view-generation:${view.inspect().resourceGeneration}`,
    entityKeys: new Set(),
    ownsAllRenderables: true,
    _commitResourceReplacement: () => view._commitResourceReplacement(),
    project: (graph) => {
      const projected = view.addPasses(graph);
      return projected.ok ? ok({ accesses: [], encode: () => undefined }) : projected;
    },
  };
}

describe('GpuDrivenView graph projection', () => {
  it('records reset, compact, and finalize in one typed graph', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([{ kind: 'create', snapshot: snapshot(1) }]);
    const sceneAvailability = GpuScene.create(device, 1).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    view
      .update(
        topology.plan(),
        sceneAvailability.scene,
        frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      )
      .unwrap();
    expect(view.inspect()).toMatchObject({
      topologyRevision: 1,
      candidateCount: 1,
      batchCount: 1,
      visibleCapacity: 1,
      updateCount: 1,
      bufferRebuilds: 1,
      candidateUploadBytes: 28,
      batchUploadBytes: 28,
      viewConstantsUploadBytes: 112,
      bindGroupCreates: 1,
    });

    view
      .update(
        topology.plan(),
        sceneAvailability.scene,
        frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      )
      .unwrap();
    expect(view.inspect()).toMatchObject({
      updateCount: 2,
      bufferRebuilds: 1,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 112,
      bindGroupCreates: 0,
    });

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(view.addPasses(graph).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes).toMatchObject([
      { name: 'gpu-driven.view-reset', kind: 'compute', dependencies: [] },
      {
        name: 'gpu-driven.frustum-compact',
        kind: 'compute',
        dependencies: ['gpu-driven.view-reset'],
      },
      {
        name: 'gpu-driven.finalize-indirect',
        kind: 'compute',
        dependencies: ['gpu-driven.frustum-compact'],
      },
    ]);
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-view' }).unwrap();
    compiled.execute({ encoder }).unwrap();
    encoder.finish().unwrap();
    expect((device as RhiNullDevice).framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
    ]);

    view.dispose();
    sceneAvailability.scene.dispose();
  });

  it('keeps last-known-good graph buffers alive until replacement promotion', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
    const projection = new RenderScene();
    const firstDelta = projection.apply([{ kind: 'create', snapshot: snapshot(1) }]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(firstDelta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    view.update(topology.plan(), sceneAvailability.scene, planes).unwrap();
    const previousVisible = view.visibleBuffer;
    expect(previousVisible).toBeDefined();
    if (previousVisible === undefined) return;

    let forceCompileFailure = false;
    const activePipeline: RenderPipeline = {
      build: ({ graph, projectGpuDriven }) => {
        const projected = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 });
        if (!projected.ok) return projected;
        if (forceCompileFailure) {
          const dangling = graph
            .createBuffer('forced-candidate-compile-failure', { size: 4 })
            .unwrap();
          graph
            .addComputePass('forced-candidate-compile-failure', {
              accesses: [{ resource: dangling, usage: 'storage-read' }],
              encode: () => undefined,
            })
            .unwrap();
        }
        return ok(undefined);
      },
    };
    const frameState = {
      compiledFrameGraph: null,
      compiledFrameGraphTopologyKey: null,
      retiredCompiledFrameGraphs: new Set(),
      activePipeline,
      installedPipelineConfig: undefined,
    } as unknown as RenderFrameState;
    const errors: unknown[] = [];
    const errorRegistry = new RhiErrorListenerRegistry();
    errorRegistry.add((error) => errors.push(error));
    const internals = { device, errorRegistry } as unknown as RenderSystemInternals;
    const pipelineState = {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState;
    const lights = {
      cascadeCount: undefined,
      pointShadow: [],
      spot: [],
    } as unknown as ExtractedLights;
    const compile = (prepared: PreparedGpuDrivenFrame) =>
      ensureCompiledFrameGraph(
        internals,
        frameState,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        1,
        1,
        undefined,
        prepared,
      );
    const compiledPrevious = compile(preparedFrame(view));
    expect(compiledPrevious).not.toBeNull();
    if (compiledPrevious === null) return;

    const secondDelta = projection.apply([{ kind: 'create', snapshot: snapshot(2) }]);
    sceneAvailability.scene.sync(secondDelta).unwrap();
    topology.rebuild(projection.slotsSnapshot());
    view.update(topology.plan(), sceneAvailability.scene, planes).unwrap();

    expect(view.inspect()).toMatchObject({ candidateCount: 2, candidateCapacity: 2 });
    forceCompileFailure = true;
    expect(compile(preparedFrame(view))).toBe(compiledPrevious);
    expect(errors).toHaveLength(1);
    expect(destroyBuffer.mock.calls.some(([buffer]) => buffer === previousVisible)).toBe(false);
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-view-lkg' }).unwrap();
    expect(compiledPrevious.execute({ encoder } as RenderPipelineFrame).ok).toBe(true);

    forceCompileFailure = false;
    const retirePrevious = vi.spyOn(compiledPrevious, 'retire');
    const acceptedGraph = compile(preparedFrame(view));
    expect(acceptedGraph).not.toBe(compiledPrevious);
    expect(retirePrevious).toHaveBeenCalledOnce();
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    expect(destroyBuffer.mock.calls.some(([buffer]) => buffer === previousVisible)).toBe(true);

    view.dispose();
    sceneAvailability.scene.dispose();
  });

  it('releases a promoted generation once when the queue fence rejects', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
    const projection = new RenderScene();
    const firstDelta = projection.apply([{ kind: 'create', snapshot: snapshot(1) }]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(firstDelta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    view.update(topology.plan(), sceneAvailability.scene, planes).unwrap();
    const firstVisible = view.visibleBuffer;
    expect(firstVisible).toBeDefined();
    if (firstVisible === undefined) return;

    const secondDelta = projection.apply([{ kind: 'create', snapshot: snapshot(2) }]);
    sceneAvailability.scene.sync(secondDelta).unwrap();
    topology.rebuild(projection.slotsSnapshot());
    view.update(topology.plan(), sceneAvailability.scene, planes).unwrap();
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockRejectedValueOnce(new Error('device lost'));
    view._commitResourceReplacement();
    await Promise.resolve();
    await Promise.resolve();
    expect(destroyBuffer.mock.calls.filter(([buffer]) => buffer === firstVisible)).toHaveLength(1);

    view.dispose();
    sceneAvailability.scene.dispose();
  });
});
