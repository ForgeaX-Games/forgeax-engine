import { frustum, mat4 } from '@forgeax/engine-math';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import {
  BatchTopology,
  batchLevelStride,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
} from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import {
  type SurfaceSubmissionCandidate,
  SurfaceSubmissionObservationOwner,
} from '../surface/submission-observation';

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

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
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
  readonly firstReadbackFrame: number;
  readonly recoveredReadbackFrame: number;
  readonly firstVisible: number;
  readonly recoveredVisible: number;
}

export interface GpuDrivenViewLifecycleEvidence {
  readonly frames: number;
  readonly bufferRebuilds: number;
  readonly candidateCapacity: number;
}

export async function runGpuDrivenViewLifecycleEvidence(
  frames = 60,
): Promise<GpuDrivenViewLifecycleEvidence> {
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
  for (let frame = 0; frame < frames; frame += 1) {
    const targetCount = frame < 4 ? 2 ** frame : frame % 2 === 0 ? 1 : 8;
    const operations: Array<
      | {
          readonly kind: 'update';
          readonly worldId: number;
          readonly entityKey: number;
          readonly snapshot: RenderableSnapshot;
        }
      | { readonly kind: 'remove'; readonly worldId: number; readonly entityKey: number }
    > = [];
    while (activeCount < targetCount) {
      activeCount += 1;
      operations.push(updateSnapshot(snapshot(activeCount, activeCount * 0.05)));
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

function lodEvidenceCamera(height: number): LodViewCamera {
  const span = (2 * 0.25 * Math.sqrt(3)) / height;
  return {
    position: new Float32Array([0, 0, 5]),
    projection: 'orthographic',
    fov: 0,
    orthoTop: span / 2,
    orthoBottom: -span / 2,
  } as unknown as LodViewCamera;
}

export async function runGpuDrivenViewGpuEvidence(): Promise<GpuDrivenViewGpuEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven evidence raw device unavailable');
  rawDevice.pushErrorScope('validation');
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
  const instancedDraw = instanced.gpuDrivenDraws?.[0];
  if (instancedDraw === undefined) throw new Error('GPU-driven LOD fixture unavailable');
  const instancedWithLod: RenderableSnapshot = {
    ...instanced,
    lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    gpuDrivenDraws: [
      {
        ...instancedDraw,
        lodRanges: [{ first: 9, count: 12, baseVertex: 4 }],
      },
    ],
  };
  const delta = projection.apply([
    updateSnapshot({
      ...instancedWithLod,
      instances: {
        transforms: new Float32Array([...visibleInstance, ...culledInstance]),
        instanceCount: 2,
        cacheKey: 1,
        archVersion: 1,
      },
    }),
    updateSnapshot(snapshot(2, 10)),
  ]);
  const sceneAvailability = GpuScene.create(device, 2).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  sceneAvailability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  view
    .update(
      topology.plan(),
      sceneAvailability.scene,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      // An orthographic height of 0.3 (below the 0.5 root-to-LOD1 boundary)
      // makes the GPU select the imported range: the unit bounds project to
      // 2 * 0.25 * sqrt(3) / span.
      lodEvidenceCamera(0.3),
    )
    .unwrap();
  const lodBatch = topology.plan().batches.find((batch) => batch.lod !== undefined);
  if (lodBatch === undefined) throw new Error('GPU-driven LOD batch unavailable');
  // Level 1 owns the batch's second command and second visible segment.
  const lodCommandOffset = lodBatch.indirectOffset + GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
  const lodVisibleByteOffset = (lodBatch.visibleBase + batchLevelStride(lodBatch)) * 16;
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
  const submissionOwner = new SurfaceSubmissionObservationOwner(() => 1);
  const beginSubmission = (frameId: number, indirectOffset: number): SurfaceSubmissionCandidate => {
    const candidate = submissionOwner.begin({
      frameId,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: view.inspect().resourceGeneration,
    });
    for (const pass of ['nearest-layer', 'color'] as const) {
      candidate.record(pass, {
        kind: 'draw-indexed-indirect',
        indirectBufferIdentity: getOpaqueResourceIdentity(indirect as object),
        indirectOffset,
        pipelineIdentity: 33,
      });
    }
    return candidate;
  };
  let currentSubmission = beginSubmission(10, lodCommandOffset);
  view.setTelemetrySubmit({ frameId: 1, deviceGeneration: 0 });
  view.addPasses(graph, 'gpu-driven', true, () => currentSubmission).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-evidence' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  encoder.copyBufferToBuffer(visible, lodVisibleByteOffset, visibleReadback, 0, 4);
  encoder.copyBufferToBuffer(indirect, lodCommandOffset, indirectReadback, 0, 20);
  encoder.copyBufferToBuffer(overflow, view.overflowByteOffset, overflowReadback, 0, 4);
  encoder.copyBufferToBuffer(
    sceneAvailability.scene.transformBuffer,
    0,
    persistentTransformReadback,
    0,
    64,
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  currentSubmission.submit(device.queue.onSubmittedWorkDone(), 1);

  // Start observing immediately, then submit the cached graph again before
  // the first mapAsync settles. The second copy must be skipped while the
  // readback is pending; compute/raster work remains submit-able.
  const pendingLodSelection = view.readLodSelection();
  if (view.readLodSelection() !== pendingLodSelection) {
    throw new Error('GPU-driven LOD telemetry did not coalesce concurrent observers');
  }
  const overlappingEncoder = device
    .createCommandEncoder({ label: 'gpu-driven-evidence-overlap' })
    .unwrap();
  compiled.execute({ encoder: overlappingEncoder }).unwrap();
  device.queue.submit([overlappingEncoder.finish().unwrap()]).unwrap();
  const lodSelection = await pendingLodSelection;
  if (lodSelection === undefined) {
    throw new Error('GPU-driven LOD selection readback unavailable or incomplete');
  }
  if (lodSelection.batches.length !== lodSelection.batchCount) {
    throw new Error('GPU-driven LOD selection readback unavailable or incomplete');
  }
  const surfaceIndirectParameters = lodSelection.surfaceIndirectParameters;
  if (surfaceIndirectParameters === undefined || surfaceIndirectParameters.length !== 2) {
    throw new Error('GPU-driven Surface indirect parameter readback unavailable');
  }
  const firstSurfaceCommand = surfaceIndirectParameters[0];
  if (
    firstSurfaceCommand === undefined ||
    firstSurfaceCommand.sequence !== lodSelection.surfaceReadback?.sequence ||
    firstSurfaceCommand.frameId !== lodSelection.surfaceReadback?.frameId ||
    firstSurfaceCommand.deviceGeneration !== lodSelection.surfaceReadback?.deviceGeneration ||
    firstSurfaceCommand.resourceGeneration !== lodSelection.surfaceReadback?.resourceGeneration ||
    firstSurfaceCommand.pass !== 'nearest-layer' ||
    firstSurfaceCommand.indirectOffset !== lodCommandOffset ||
    firstSurfaceCommand.count !== 12 ||
    firstSurfaceCommand.instanceCount !== 1 ||
    firstSurfaceCommand.first !== 9 ||
    firstSurfaceCommand.baseVertex !== 4 ||
    firstSurfaceCommand.firstInstance !== 0
  ) {
    throw new Error(
      `GPU-driven Surface indirect parameters do not match the submitted batch: ${JSON.stringify({
        firstSurfaceCommand,
        surfaceReadback: lodSelection.surfaceReadback,
      })}`,
    );
  }
  if (
    lodSelection.submit === undefined ||
    lodSelection.submit.frameId !== 1 ||
    lodSelection.submit.deviceGeneration !== 0
  ) {
    throw new Error('GPU-driven LOD telemetry lost the copy submit identity');
  }
  await device.queue.onSubmittedWorkDone();

  // After unmap, a later cached-graph submission must restore telemetry
  // observation rather than leaving the latch permanently consumed.
  const recoveryProjection = mat4.identity(mat4.create());
  recoveryProjection[12] = 10;
  view
    .update(
      topology.plan(),
      sceneAvailability.scene,
      frustum.fromViewProjection(frustum.create(), recoveryProjection),
    )
    .unwrap();
  view.setTelemetrySubmit({ frameId: 2, deviceGeneration: 0 });
  const recoveryEncoder = device
    .createCommandEncoder({ label: 'gpu-driven-evidence-recovery' })
    .unwrap();
  currentSubmission = beginSubmission(11, 32);
  compiled.execute({ encoder: recoveryEncoder }).unwrap();
  device.queue.submit([recoveryEncoder.finish().unwrap()]).unwrap();
  currentSubmission.submit(device.queue.onSubmittedWorkDone(), 1);
  await device.queue.onSubmittedWorkDone();
  const recoveredLodSelection = await view.readLodSelection();
  if (
    recoveredLodSelection === undefined ||
    recoveredLodSelection === lodSelection ||
    recoveredLodSelection.visible === lodSelection.visible ||
    lodSelection.surfaceReadback?.frameId !== 10 ||
    recoveredLodSelection.surfaceReadback?.frameId !== 11
  ) {
    throw new Error('GPU-driven LOD telemetry did not recover after a skipped copy');
  }
  if (
    recoveredLodSelection.surfaceIndirectParameters?.some(
      (command) =>
        command.sequence !== recoveredLodSelection.surfaceReadback?.sequence ||
        command.frameId !== recoveredLodSelection.surfaceReadback?.frameId ||
        command.deviceGeneration !== recoveredLodSelection.surfaceReadback?.deviceGeneration ||
        command.resourceGeneration !== recoveredLodSelection.surfaceReadback?.resourceGeneration,
    )
  ) {
    throw new Error('GPU-driven recovered Surface indirect parameters lost readback identity');
  }
  if (
    recoveredLodSelection.submit === undefined ||
    recoveredLodSelection.submit.frameId !== 2 ||
    recoveredLodSelection.submit.deviceGeneration !== 0
  ) {
    throw new Error('GPU-driven LOD telemetry reused a stale submit identity');
  }
  if (
    lodSelection.surfaceReadback === undefined ||
    recoveredLodSelection.surfaceReadback === undefined
  ) {
    throw new Error('GPU-driven LOD telemetry lost Surface readback identity');
  }
  const validationError = await rawDevice.popErrorScope();
  if (validationError !== null) {
    throw new Error(`GPU-driven telemetry overlap validation failed: ${validationError.message}`);
  }

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
    firstReadbackFrame: lodSelection.surfaceReadback.frameId,
    recoveredReadbackFrame: recoveredLodSelection.surfaceReadback.frameId,
    firstVisible: lodSelection.visible,
    recoveredVisible: recoveredLodSelection.visible,
  };
  view.dispose();
  sceneAvailability.scene.dispose();
  device.destroyBuffer(visibleReadback);
  device.destroyBuffer(indirectReadback);
  device.destroyBuffer(overflowReadback);
  device.destroyBuffer(persistentTransformReadback);
  return evidence;
}

export interface GpuDrivenViewOcclusionFrame {
  readonly visible: number;
  readonly culled: number;
  readonly late: number;
  readonly bufferRebuilds: number;
}

const OCCLUSION_PYRAMID_SIZE = 64;
const OCCLUSION_EMPTY = 3.402823e38;

/**
 * Two-phase HZB evidence on the real GPU API. A furthest pyramid whose left
 * half holds a wall at distance 5 fronts three unit cubes at distance 10:
 * one fully behind the wall, one straddling its edge, one beside it. Frame 0
 * has no history; frame 1 runs the full two-phase path; frame 2 removes the
 * wall, so the hidden cube must come back through the late phase. With
 * `grow`, frame 2 keeps the wall and instead adds cubes beside it so the view
 * buffers rebuild; the hidden cube must still skip the early phase.
 */
export async function runGpuDrivenViewOcclusionEvidence(
  options: { readonly occlusionFootprintScale?: number; readonly grow?: boolean } = {},
): Promise<readonly GpuDrivenViewOcclusionFrame[]> {
  const { occlusionFootprintScale, grow = false } = options;
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['indirect-first-instance'] })
  ).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven occlusion raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-occlusion',
    })
  ).unwrap();
  const projection = new RenderScene();
  const at = (entityKey: number, x: number) => {
    const value = snapshot(entityKey, x);
    const world = new Float32Array(value.transform.world);
    world[14] = -10;
    return updateSnapshot({ ...value, transform: { world } });
  };
  // Cube bounds span uv x +-0.0625 around 0.25 + x / 4; the wall ends at 0.5.
  const delta = projection.apply([-1, -0.2, 1].map((x, index) => at(index + 1, x)));
  const sceneAvailability = GpuScene.create(device, 16).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  sceneAvailability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
    ...(occlusionFootprintScale === undefined ? {} : { occlusionFootprintScale }),
  }).unwrap();
  // Reversed-Z orthographic camera at the origin looking down -Z.
  const near = 0.1;
  const far = 100;
  const viewProjection = mat4.identity(mat4.create());
  viewProjection[0] = 0.5;
  viewProjection[5] = 0.5;
  viewProjection[10] = 1 / (far - near);
  viewProjection[14] = far / (far - near);
  const planes = frustum.fromViewProjection(frustum.create(), viewProjection);
  const occlusionCamera = {
    viewProjection: new Float32Array(viewProjection),
    near,
    far,
    orthographic: true,
    historyKey: 'occlusion-evidence',
  };

  const levels = Math.log2(OCCLUSION_PYRAMID_SIZE) + 1;
  const pyramid = device
    .createTexture({
      label: 'gpu-driven-occlusion-pyramid',
      format: 'r32float',
      size: { width: OCCLUSION_PYRAMID_SIZE, height: OCCLUSION_PYRAMID_SIZE },
      mipLevelCount: levels,
      usage: 0x04 | 0x02,
    })
    .unwrap();
  const pyramidView = device.createTextureView(pyramid, { mipLevelCount: levels }).unwrap();
  const writePyramid = (wall: boolean) => {
    for (let level = 0; level < levels; level += 1) {
      const size = OCCLUSION_PYRAMID_SIZE >> level;
      const texels = new Float32Array(size * size).fill(OCCLUSION_EMPTY);
      // A furthest reduction keeps the wall only where every source texel had it.
      if (wall && size > 1) {
        for (let y = 0; y < size; y += 1) texels.fill(5, y * size, y * size + size / 2);
      }
      device.queue
        .writeTexture(
          { texture: pyramid, mipLevel: level, origin: [0, 0, 0] },
          texels,
          { offset: 0, bytesPerRow: size * 4, rowsPerImage: size },
          { width: size, height: size, depthOrArrayLayers: 1 },
        )
        .unwrap();
    }
  };

  const compileFrame = () => {
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const importedPyramid = graph
      .importTexture(
        'occlusion-evidence-pyramid',
        {
          format: 'r32float',
          size: { width: OCCLUSION_PYRAMID_SIZE, height: OCCLUSION_PYRAMID_SIZE },
          mipLevelCount: levels,
          usage: 0x04 | 0x02,
        },
        () => pyramid,
      )
      .unwrap();
    const importedPyramidView = graph
      .importView(importedPyramid, { mipLevelCount: levels }, () => pyramidView)
      .unwrap();
    const resources = view
      .addPasses(graph, 'gpu-driven', true, undefined, undefined, true)
      .unwrap();
    if (resources.addLateOcclusion === undefined) {
      throw new Error('GPU-driven occlusion did not reserve a late phase');
    }
    resources.addLateOcclusion(importedPyramidView).unwrap();
    return graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  };

  const frames: GpuDrivenViewOcclusionFrame[] = [];
  const retirements: Array<Promise<unknown>> = [];
  let compiled: CompiledRenderGraph<{ readonly encoder: RhiCommandEncoder }> | undefined;
  for (const wall of grow ? [true, true, true] : [true, true, false]) {
    if (grow && frames.length === 2) {
      const grown = projection.apply([4, 5, 6, 7, 8].map((entityKey) => at(entityKey, 1)));
      sceneAvailability.scene.sync(grown).unwrap();
      topology.apply(grown);
    }
    writePyramid(wall);
    view
      .update(
        topology.plan(),
        sceneAvailability.scene,
        planes,
        undefined,
        0,
        undefined,
        undefined,
        occlusionCamera,
      )
      .unwrap();
    const rebuilds = view.inspect().bufferRebuilds;
    if (compiled === undefined || rebuilds !== frames.at(-1)?.bufferRebuilds) {
      if (compiled !== undefined) retirements.push(compiled.retire());
      compiled = compileFrame();
      view._commitResourceReplacement();
    }
    const encoder = device
      .createCommandEncoder({ label: `gpu-driven-occlusion-${frames.length}` })
      .unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const selection = await view.readLodSelection();
    if (selection?.occlusion === undefined) {
      throw new Error('GPU-driven occlusion readback lost its late-phase facts');
    }
    frames.push({
      visible: selection.visible,
      culled: selection.occlusion.culled,
      late: selection.occlusion.late,
      bufferRebuilds: rebuilds,
    });
  }

  if (compiled !== undefined) retirements.push(compiled.retire());
  await Promise.all(retirements);
  const validationError = await rawDevice.popErrorScope();
  view.dispose();
  sceneAvailability.scene.dispose();
  device.destroyTexture(pyramid);
  if (validationError !== null) {
    throw new Error(`GPU-driven occlusion validation failed: ${validationError.message}`);
  }
  return frames;
}
