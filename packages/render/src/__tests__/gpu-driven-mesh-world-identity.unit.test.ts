import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { gpuDrivenMeshesForFrame } from '../record/frame';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import {
  type PersistentGpuDrivenState,
  RenderScene,
  type RenderSceneSlot,
} from '../scene/render-scene';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

function slot(
  slot: number,
  worldId: number,
  entityKey: number,
  assetHandle: number,
): RenderSceneSlot {
  return {
    slot,
    generation: 1,
    worldId,
    entityKey,
    snapshot: {
      assetHandle,
      worldId,
      entityKey,
      transform: { world: new Float32Array(16) },
      material: undefined,
      materials: [],
      materialBindingSources: [],
    } as never,
  };
}

function snapshot(worldId: number, entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: JSON.stringify({ textures: [], samplers: [], video: [] }),
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

function mesh(device: RhiNullDevice, indexCount: number): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = device
    .createBuffer({
      size: Math.max(8, indexCount * 2),
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    vboBytes: 144,
    iboBytes: Math.max(8, indexCount * 2),
    indexCount,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

async function productionFixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const projection = new RenderScene();
  const assetHandle = 2048;
  const delta = projection.apply([
    updateSnapshot(preparedPbrSnapshot(snapshot(0, 11, assetHandle))),
    updateSnapshot(preparedPbrSnapshot(snapshot(1, 22, assetHandle))),
  ]);
  const availability = GpuScene.create(device, 2).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  return {
    device,
    shader,
    viewLayout,
    projection,
    availability,
    topology,
    inputs: standardPbrInputs(device, shader, viewLayout),
    production: new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    }),
  };
}

describe('GPU-driven mesh world identity', () => {
  it('keeps same numeric asset handles distinct across World residency namespaces', () => {
    const worldA = new World();
    const worldB = new World();
    const meshA = { vboBytes: 144 } as unknown as MeshGpuHandles;
    const meshB = { vboBytes: 288 } as unknown as MeshGpuHandles;
    const getMeshGpuHandles = vi.fn((_handle: number, world: World) =>
      world === worldA ? meshA : world === worldB ? meshB : undefined,
    );
    const internals = {
      gpuStore: {
        meshResidencyEpoch: 1,
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      meshes: new Map<number, MeshGpuHandles>(),
    } as unknown as PipelineState;
    const state = {
      scene: {},
      plan: {},
      slots: [slot(3, 0, 11, 2048), slot(9, 1, 22, 2048)],
      worldKeys: [101, 202],
    } as unknown as PersistentGpuDrivenState;

    const result = gpuDrivenMeshesForFrame(internals, pipelineState, [worldA, worldB], state);

    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
    expect(result.get(3)).toBe(meshA);
    expect(result.get(9)).toBe(meshB);
    expect(result.get(2048)).toBeUndefined();
  });

  it('refreshes the slot projection when the World source changes at the same residency epoch', () => {
    const worldA = new World();
    const worldB = new World();
    const meshA = { vboBytes: 144 } as unknown as MeshGpuHandles;
    const meshB = { vboBytes: 288 } as unknown as MeshGpuHandles;
    const getMeshGpuHandles = vi.fn((_handle: number, world: World) =>
      world === worldA ? meshA : world === worldB ? meshB : undefined,
    );
    const internals = {
      gpuStore: {
        meshResidencyEpoch: 4,
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      meshes: new Map<number, MeshGpuHandles>(),
    } as unknown as PipelineState;
    const state = {
      scene: {},
      plan: {},
      slots: [slot(3, 0, 11, 2048)],
    } as unknown as PersistentGpuDrivenState;

    const first = gpuDrivenMeshesForFrame(internals, pipelineState, [worldA], state);
    const afterSourceEdit = gpuDrivenMeshesForFrame(internals, pipelineState, [worldB], state);

    expect(first.get(3)).toBe(meshA);
    expect(afterSourceEdit.get(3)).toBe(meshB);
    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
  });

  it('projects distinct final raster mesh resources for two Worlds sharing one handle', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const first = slots[0];
    const second = slots[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const meshes = new Map<number, MeshGpuHandles>([
      [first.slot, firstMesh],
      [second.slot, secondMesh],
      // Keep the old raw entry in the fixture so this regression also catches
      // production code that silently falls back to the handle key.
      [2048, firstMesh],
    ]);
    const prepared = fixture.production
      .prepare({
        ...fixture.inputs,
        scene: {
          scene: fixture.availability.scene,
          plan: fixture.topology.plan(),
          slots,
          slotAt: fixture.projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const projected = prepared
      .project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1)
      .unwrap();
    expect(projected.accesses.filter((access) => access.usage === 'vertex-read')).toHaveLength(2);
    expect(projected.accesses.filter((access) => access.usage === 'index-read')).toHaveLength(2);
    expect(fixture.production.inspect()).toMatchObject({ batchCount: 2, indirectDrawCount: 2 });
    fixture.production.dispose();
    fixture.availability.scene.dispose();
  });

  it('rebuilds filtered mesh selection after a composition source edit with an unchanged plan', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const first = slots[0];
    const second = slots[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const sourcePlan = fixture.topology.plan();
    const baseScene = {
      scene: fixture.availability.scene,
      plan: sourcePlan,
      slots,
      slotAt: fixture.projection.slotAt,
    } satisfies PersistentGpuDrivenState;
    const firstPrepared = fixture.production
      .prepare({
        ...fixture.inputs,
        scene: baseScene,
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map<number, MeshGpuHandles>([
          [first.slot, firstMesh],
          [second.slot, secondMesh],
          [2048, firstMesh],
        ]),
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(firstPrepared).toBeDefined();
    if (firstPrepared === undefined) return;
    const editedSlots = Object.freeze(
      slots.map((value) =>
        value.slot === first.slot
          ? {
              ...value,
              snapshot: { ...value.snapshot, transform: { world: new Float32Array(16) } },
            }
          : value,
      ),
    );
    const secondPrepared = fixture.production
      .prepare({
        ...fixture.inputs,
        scene: {
          ...baseScene,
          slots: editedSlots,
          slotAt: (index: number) => editedSlots.find((value) => value.slot === index),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map<number, MeshGpuHandles>([
          [first.slot, secondMesh],
          [second.slot, secondMesh],
          [2048, firstMesh],
        ]),
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(secondPrepared).toBeDefined();
    expect(fixture.production.inspect().filteredPlanBuilds).toBe(1);
    expect(secondPrepared?.topologySignature).not.toBe(firstPrepared.topologySignature);
    // A fresh slots snapshot with the same structure and resident meshes is
    // not a structural edit: prepared rows and the filtered plan are retained.
    const retainedMeshes = () =>
      new Map<number, MeshGpuHandles>([
        [first.slot, firstMesh],
        [second.slot, secondMesh],
      ]);
    const prepareRetained = (meshBySlot: ReadonlyMap<number, MeshGpuHandles>) =>
      fixture.production
        .prepare({
          ...fixture.inputs,
          scene: { ...baseScene, slots: Object.freeze([...slots]) },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot,
          viewBindGroupLayout: fixture.viewLayout,
          meshResidencyEpoch: 1,
        })
        .unwrap();
    prepareRetained(retainedMeshes());
    prepareRetained(retainedMeshes());
    expect(fixture.production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      filteredBatchBuilds: 0,
    });
    // Replacing one slot's resident mesh at the same epoch re-derives only the
    // batch that consulted it.
    prepareRetained(
      new Map<number, MeshGpuHandles>([
        [first.slot, firstMesh],
        [second.slot, firstMesh],
      ]),
    );
    expect(fixture.production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      preparedBatchBuilds: 1,
    });
    fixture.production.dispose();
    fixture.availability.scene.dispose();
  });
});
