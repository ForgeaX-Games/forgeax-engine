import { frustum, mat4 } from '@forgeax/engine-math';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const GPU_MAP_MODE_READ = 0x0001;

function snapshot(entityKey: number, x: number): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  const material = {
    baseColor: new Float32Array([0.25, 0.5, 0.75]),
    metallic: 0.1,
    roughness: 0.9,
  } as MaterialSnapshot;
  return {
    assetHandle: 3,
    transform: { world: new Float32Array(world) },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 3,
        count: 36,
        baseVertex: -2,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque-pbr',
        materialResourceClass: 'plain',
      },
    ],
  };
}

export interface GpuDrivenViewGpuEvidence {
  readonly visibleInstance: number;
  readonly indexCount: number;
  readonly instanceCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
  readonly overflow: number;
  readonly persistentTranslationX: number;
}

export interface GpuDrivenViewLifecycleEvidence {
  readonly frames: number;
  readonly bufferRebuilds: number;
  readonly candidateCapacity: number;
}

export async function runGpuDrivenViewLifecycleEvidence(): Promise<GpuDrivenViewLifecycleEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven lifecycle raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-lifecycle',
    })
  ).unwrap();
  const projection = new RenderScene();
  const sceneAvailability = GpuScene.create(device, 8).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  const topology = new BatchTopology();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const retirements: Array<Promise<unknown>> = [];
  let activeCount = 0;
  let previous: CompiledRenderGraph<{ readonly encoder: RhiCommandEncoder }> | undefined;
  const frames = 300;

  for (let frame = 0; frame < frames; frame += 1) {
    const targetCount = frame < 4 ? 2 ** frame : frame % 2 === 0 ? 1 : 8;
    const operations: Array<
      | { readonly kind: 'create'; readonly snapshot: RenderableSnapshot }
      | { readonly kind: 'remove'; readonly worldId: number; readonly entityKey: number }
    > = [];
    while (activeCount < targetCount) {
      activeCount += 1;
      operations.push({ kind: 'create', snapshot: snapshot(activeCount, activeCount * 0.05) });
    }
    while (activeCount > targetCount) {
      operations.push({ kind: 'remove', worldId: 0, entityKey: activeCount });
      activeCount -= 1;
    }
    const delta = projection.apply(operations);
    sceneAvailability.scene.sync(delta).unwrap();
    topology.apply(delta);
    view.update(topology.plan(), sceneAvailability.scene, planes).unwrap();

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    if (previous !== undefined) retirements.push(previous.retire());
    view._commitResourceReplacement();
    const encoder = device
      .createCommandEncoder({ label: `gpu-driven-lifecycle-${frame}` })
      .unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    previous = compiled;
  }

  await device.queue.onSubmittedWorkDone();
  if (previous !== undefined) retirements.push(previous.retire());
  await Promise.all(retirements);
  const validationError = await rawDevice.popErrorScope();
  if (validationError !== null) {
    throw new Error(`GPU-driven lifecycle validation failed: ${validationError.message}`);
  }
  const inspection = view.inspect();
  view.dispose();
  sceneAvailability.scene.dispose();
  await device.queue.onSubmittedWorkDone();
  return {
    frames,
    bufferRebuilds: inspection.bufferRebuilds,
    candidateCapacity: inspection.candidateCapacity,
  };
}

export async function runGpuDrivenViewGpuEvidence(): Promise<GpuDrivenViewGpuEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-evidence',
    })
  ).unwrap();
  const projection = new RenderScene();
  const visibleInstance = mat4.identity(mat4.create());
  const culledInstance = mat4.identity(mat4.create());
  culledInstance[12] = 10;
  const instanced = snapshot(1, 0);
  const delta = projection.apply([
    {
      kind: 'create',
      snapshot: {
        ...instanced,
        instances: {
          transforms: new Float32Array([...visibleInstance, ...culledInstance]),
          instanceCount: 2,
          cacheKey: 1,
          archVersion: 1,
        },
      },
    },
    { kind: 'create', snapshot: snapshot(2, 10) },
  ]);
  const sceneAvailability = GpuScene.create(device, 2).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
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
  const visible = view.visibleBuffer;
  const indirect = view.indirectBuffer;
  const overflow = view.overflowBuffer;
  if (visible === undefined || indirect === undefined || overflow === undefined) {
    throw new Error('GPU-driven output buffers unavailable');
  }
  const visibleReadback = device
    .createBuffer({
      label: 'gpu-driven-visible-readback',
      size: 4,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const indirectReadback = device
    .createBuffer({
      label: 'gpu-driven-indirect-readback',
      size: 20,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const overflowReadback = device
    .createBuffer({
      label: 'gpu-driven-overflow-readback',
      size: 4,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const persistentTransformReadback = device
    .createBuffer({
      label: 'gpu-driven-persistent-transform-readback',
      size: 64,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  view.addPasses(graph).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-evidence' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  encoder.copyBufferToBuffer(visible, 0, visibleReadback, 0, 4);
  encoder.copyBufferToBuffer(indirect, 0, indirectReadback, 0, 20);
  encoder.copyBufferToBuffer(overflow, view.overflowByteOffset, overflowReadback, 0, 4);
  encoder.copyBufferToBuffer(
    sceneAvailability.scene.transformBuffer,
    0,
    persistentTransformReadback,
    0,
    64,
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();

  const visibleMap = (await visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const visibleValue = new DataView(visibleMap.getMappedRange().unwrap()).getUint32(0, true);
  visibleMap.unmap();
  const indirectMap = (await indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const indirectValue = new DataView(indirectMap.getMappedRange().unwrap().slice(0));
  indirectMap.unmap();
  const overflowMap = (await overflowReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const overflowValue = new DataView(overflowMap.getMappedRange().unwrap()).getUint32(0, true);
  overflowMap.unmap();
  const persistentTransformMap = (
    await persistentTransformReadback.mapAsync(GPU_MAP_MODE_READ)
  ).unwrap();
  const persistentTranslationX = new DataView(
    persistentTransformMap.getMappedRange().unwrap(),
  ).getFloat32(12 * 4, true);
  persistentTransformMap.unmap();

  const evidence = {
    visibleInstance: visibleValue,
    indexCount: indirectValue.getUint32(0, true),
    instanceCount: indirectValue.getUint32(4, true),
    firstIndex: indirectValue.getUint32(8, true),
    baseVertex: indirectValue.getInt32(12, true),
    firstInstance: indirectValue.getUint32(16, true),
    overflow: overflowValue,
    persistentTranslationX,
  };
  view.dispose();
  sceneAvailability.scene.dispose();
  device.destroyBuffer(visibleReadback);
  device.destroyBuffer(indirectReadback);
  device.destroyBuffer(overflowReadback);
  device.destroyBuffer(persistentTransformReadback);
  return evidence;
}
