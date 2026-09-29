import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology, batchLevelStride } from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import { type ShadowViewIdentity, ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { addTypedShadowPasses } from '../typed-shadow-passes';

const GPU_MAP_MODE_READ = 0x0001;

const material = {
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot;

function snapshot(entityKey: number, assetHandle = 3, x = 0): RenderableSnapshot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  return {
    assetHandle,
    transform: { world },
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

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function topology(): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: {
      width: 64,
      height: 64,
      storageFormat: 'rgba8unorm',
      viewFormat: 'rgba8unorm',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: 32, cascadeCount: 2 },
      spotMapSize: 32,
      pointCount: 1,
      pointFaceSize: 16,
      spotCount: 1,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'shadow-view-dawn-test',
    gpuDrivenTopologySignature: 'shadow-view-dawn-test',
  };
}

const identities: readonly ShadowViewIdentity[] = [
  { kind: 'directional', index: 0 },
  { kind: 'point', index: 0, face: 0 },
  { kind: 'spot', index: 0 },
];

describe('GPU-driven shadow views Dawn structural evidence', () => {
  it('retains the initialized empty spot depth layer through 60 completed frames', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const base = topology();
    const input = {
      ...base,
      shadow: { ...base.shadow, directional: 'disabled' as const, pointCount: 0, spotCount: 0 },
    };
    const targets = addTypedShadowPasses(graph, input).unwrap();
    const spotSize = input.shadow.spotMapSize;
    const bytes = spotSize * 256;
    const readback = device
      .createBuffer({ size: bytes, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const output = graph
      .importBuffer(
        'empty-spot-readback',
        { size: bytes, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => readback,
      )
      .unwrap();
    graph
      .addCopyPass('empty-spot-depth-readback', {
        accesses: [
          { resource: targets.spot.view, usage: 'copy-src' },
          { resource: output, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(targets.spot.texture).unwrap() as unknown as GPUTexture },
            {
              buffer: resources.buffer(output).unwrap() as unknown as GPUBuffer,
              bytesPerRow: 256,
              rowsPerImage: spotSize,
            },
            { width: spotSize, height: spotSize, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    let rasterPasses = 0;
    for (let frameId = 0; frameId < 60; frameId++) {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = vi.spyOn(encoder, 'beginRenderPass');
      compiled
        .execute({
          encoder,
          frameState: { spotShadowSnapshots: [] },
        } as unknown as RenderPipelineFrame)
        .unwrap();
      rasterPasses += begin.mock.calls.length;
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const depth = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      for (let row = 0; row < spotSize; row++)
        expect(depth.subarray(row * 64, row * 64 + spotSize).every((value) => value === 0)).toBe(
          true,
        );
    }
    expect(rasterPasses).toBe(1);
    (await compiled.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
  });

  it('selects each LOD level on the GPU from the view camera without reuploading topology', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const availability = GpuScene.create(device, 1).unwrap();
    if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
    availability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const source = topologyOwner.plan();
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({
        ...batch,
        lod: { coverages: [0, 0.5], ranges: [{ first: 7, count: 12, baseVertex: 0 }] },
      })),
    };
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const readback = device
      .createBuffer({
        size: 40,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    // Orthographic projected height is 2 * |half extent| / (top - bottom);
    // the unit-cube bounds give 2 * sqrt(3) / span.
    const renderAt = async (height: number) => {
      const span = (2 * Math.sqrt(3)) / height;
      const lodCamera = {
        position: new Float32Array([0, 0, 5]),
        projection: 'orthographic',
        fov: 0,
        orthoTop: span / 2,
        orthoBottom: -span / 2,
      } as unknown as LodViewCamera;
      view.update(plan, availability.scene, planes, lodCamera).unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      if (indirect === undefined) throw new Error('indirect buffer missing');
      encoder.copyBufferToBuffer(indirect, 0, readback, 0, 40);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      view._commitResourceReplacement();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      return Array.from(words);
    };

    // One indirect command per level; the unselected level draws nothing.
    expect(await renderAt(0.6)).toEqual([36, 1, 0, 0, 0, 12, 0, 7, 0, 0]);
    expect(await renderAt(0.4)).toEqual([36, 0, 0, 0, 0, 12, 1, 7, 0, 0]);
    expect(view.inspect()).toMatchObject({
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
    });

    device.destroyBuffer(readback);
    view.dispose();
    availability.scene.dispose();
  });

  it('emits a crossfade pair into both level segments with opposite signed coverage', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const availability = GpuScene.create(device, 1).unwrap();
    if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
    availability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const source = topologyOwner.plan();
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({
        ...batch,
        lod: {
          coverages: [1, 0.5],
          hysteresis: 0.08,
          crossfade: true,
          ranges: [{ first: 7, count: 12, baseVertex: 0 }],
        },
      })),
    };
    const batch = plan.batches[0];
    if (batch === undefined) throw new Error('missing LOD batch');
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const indirectReadback = device
      .createBuffer({ size: 40, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const visibleReadback = device
      .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const renderAt = async (height: number) => {
      const span = (2 * Math.sqrt(3)) / height;
      const lodCamera = {
        position: new Float32Array([0, 0, 5]),
        projection: 'orthographic',
        fov: 0,
        orthoTop: span / 2,
        orthoBottom: -span / 2,
      } as unknown as LodViewCamera;
      view.update(plan, availability.scene, planes, lodCamera).unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      const visible = view.visibleBuffer;
      if (indirect === undefined || visible === undefined) throw new Error('outputs missing');
      encoder.copyBufferToBuffer(indirect, 0, indirectReadback, 0, 40);
      const levelBytes = batchLevelStride(batch) * 16;
      encoder.copyBufferToBuffer(visible, batch.visibleBase * 16, visibleReadback, 0, 16);
      encoder.copyBufferToBuffer(
        visible,
        batch.visibleBase * 16 + levelBytes,
        visibleReadback,
        16,
        16,
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      view._commitResourceReplacement();
      const args = (await indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const words = Array.from(new Uint32Array(args.getMappedRange().unwrap().slice(0)));
      args.unmap();
      const items = (await visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const fades = new Float32Array(items.getMappedRange().unwrap().slice(0));
      items.unmap();
      return { instances: [words[1], words[6]], fades: [fades[3], fades[7]] };
    };

    // Exactly on the boundary both levels draw, with complementary +t / -t.
    const paired = await renderAt(0.5);
    expect(paired.instances).toEqual([1, 1]);
    expect(paired.fades[0]).toBeCloseTo(0.5, 5);
    expect(paired.fades[1]).toBe(-(paired.fades[0] ?? Number.NaN));
    // Falsifier: outside the band exactly one level draws at full coverage.
    const hard = await renderAt(0.9);
    expect(hard.instances).toEqual([1, 0]);
    expect(hard.fades[0]).toBe(0);
    expect(view.inspect()).toMatchObject({ candidateUploadBytes: 0, batchUploadBytes: 0 });
    device.destroyBuffer(indirectReadback).unwrap();
    device.destroyBuffer(visibleReadback).unwrap();
    view.dispose();
    availability.scene.dispose();
  });

  it('keeps all shadow attachments depth-write owned by the typed graph', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const added = addTypedShadowPasses(graph, topology());
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    const shadowPasses = compiled
      .inspect()
      .passes.filter(
        (pass) =>
          pass.name.startsWith('shadowCascade') ||
          pass.name.startsWith('point-shadow-') ||
          pass.name.startsWith('spot-shadow-'),
      );
    expect(shadowPasses).toHaveLength(9);
    expect(
      shadowPasses.every((pass) =>
        pass.accesses.some((access) => access.usage === 'depth-stencil-write'),
      ),
    ).toBe(true);
  });

  it('executes three view-local culls and reads one indirect result per view', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (
      await rhi.createShaderModule(device, {
        code: GPU_DRIVEN_VIEW_WGSL,
        label: 'gpu-driven-shadow-views-dawn',
      })
    ).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([
      updateSnapshot(snapshot(1, 3, -0.5)),
      updateSnapshot(snapshot(2, 4, 0.5)),
    ]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const inputs = identities.map((identity) => ({
      identity,
      sourcePlan: topologyOwner.plan(),
      scene: sceneAvailability.scene,
      planes,
      candidatePrimitiveIndices: [0, 1],
    }));
    for (const input of inputs) {
      const update = pool.update(input).unwrap();
      expect(update.cache).toBe('invalidated');
      expect(update.plan.candidateCount).toBe(2);
      expect(update.plan.batches).toHaveLength(2);
    }

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const projections = identities.map((identity) => pool.project(graph, identity).unwrap());
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const passNames = compiled.inspect().passes.map((pass) => pass.name);
    expect(passNames).toEqual(
      identities.flatMap((identity) => {
        const prefix =
          identity.kind === 'directional'
            ? `gpu-driven.shadow.directional-cascade-${identity.index}`
            : identity.kind === 'point'
              ? `gpu-driven.shadow.point-cube-face-${identity.index}-${identity.face}`
              : `gpu-driven.shadow.spot-atlas-${identity.index}`;
        return [
          `${prefix}.view-reset`,
          `${prefix}.frustum-compact`,
          `${prefix}.finalize-indirect`,
          `${prefix}.lod-selection-readback`,
        ];
      }),
    );

    const readbacks = projections.map((projection, index) => {
      const view = projection.view;
      const visible = view.visibleBuffer;
      const indirect = view.indirectBuffer;
      const overflow = view.overflowBuffer;
      if (visible === undefined || indirect === undefined || overflow === undefined) {
        throw new Error(`shadow view ${index} has no GPU output buffers`);
      }
      return {
        view,
        visible,
        indirect,
        overflow,
        visibleReadback: device
          .createBuffer({
            label: `shadow-view-${index}-visible-readback`,
            size: 1040,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
        indirectReadback: device
          .createBuffer({
            label: `shadow-view-${index}-indirect-readback`,
            size: 40,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
        overflowReadback: device
          .createBuffer({
            label: `shadow-view-${index}-overflow-readback`,
            size: 4,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
      };
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-shadow-views-dawn' }).unwrap();
    compiled.execute({ encoder }).unwrap();
    for (const readback of readbacks) {
      encoder.copyBufferToBuffer(readback.visible, 0, readback.visibleReadback, 0, 1040);
      encoder.copyBufferToBuffer(readback.indirect, 0, readback.indirectReadback, 0, 40);
      encoder.copyBufferToBuffer(
        readback.overflow,
        readback.view.overflowByteOffset,
        readback.overflowReadback,
        0,
        4,
      );
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    pool._commitResourceReplacement();

    for (const readback of readbacks) {
      const visibleMap = (await readback.visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const visible = new Uint32Array(visibleMap.getMappedRange().unwrap().slice(0));
      visibleMap.unmap();
      const indirectMap = (await readback.indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const indirect = new Uint32Array(indirectMap.getMappedRange().unwrap().slice(0));
      indirectMap.unmap();
      const overflowMap = (await readback.overflowReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const overflow = new Uint32Array(overflowMap.getMappedRange().unwrap().slice(0));
      overflowMap.unmap();
      // Visible items address the shared GPU Scene tables directly:
      // (instance row, material row, candidate row for unskinned draws,
      // LOD fade bits).
      const scene = sceneAvailability.scene;
      expect(Array.from(visible.slice(0, 4))).toEqual([
        scene.instanceIndexForSlot(0, 0),
        scene.materialIndexForSlot(0, 0),
        0,
        0,
      ]);
      expect(Array.from(visible.slice(256, 260))).toEqual([
        scene.instanceIndexForSlot(1, 0),
        scene.materialIndexForSlot(1, 0),
        1,
        0,
      ]);
      expect(scene.instanceIndexForSlot(1, 0)).not.toBe(scene.instanceIndexForSlot(0, 0));
      expect(Array.from(indirect)).toEqual([36, 1, 0, 0, 0, 36, 1, 0, 0, 0]);
      expect(Array.from(overflow)).toEqual([0]);
      device.destroyBuffer(readback.visibleReadback);
      device.destroyBuffer(readback.indirectReadback);
      device.destroyBuffer(readback.overflowReadback);
    }

    for (const input of inputs) expect(pool.update(input).unwrap().cache).toBe('hit');
    const hitGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    for (const identity of identities)
      expect(pool.project(hitGraph, identity).unwrap().passNames).toEqual([]);
    expect(
      hitGraph
        .compile({ device, surfaceSize: { width: 1, height: 1 } })
        .unwrap()
        .inspect().passes,
    ).toHaveLength(0);

    const pointIdentity = identities[1];
    const pointInput = inputs[1];
    if (pointIdentity === undefined || pointInput === undefined) {
      throw new Error('point shadow input missing');
    }
    pool.invalidate('skin-palette-changed', pointIdentity);
    expect(pool.update(pointInput).unwrap().cache).toBe('invalidated');
    const invalidatedGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const directionalIdentity = identities[0];
    const spotIdentity = identities[2];
    if (directionalIdentity === undefined || spotIdentity === undefined) {
      throw new Error('shadow identities missing');
    }
    expect(pool.project(invalidatedGraph, directionalIdentity).unwrap().passNames).toEqual([]);
    expect(pool.project(invalidatedGraph, pointIdentity).unwrap().passNames).toHaveLength(3);
    expect(pool.project(invalidatedGraph, spotIdentity).unwrap().passNames).toEqual([]);
    expect(
      invalidatedGraph
        .compile({ device, surfaceSize: { width: 1, height: 1 } })
        .unwrap()
        .inspect().passes,
    ).toHaveLength(4);

    pool.dispose();
    sceneAvailability.scene.dispose();
  });
});
