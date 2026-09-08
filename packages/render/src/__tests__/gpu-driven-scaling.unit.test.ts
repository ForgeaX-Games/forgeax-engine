import { mat4 } from '@forgeax/engine-math';
import { beforeAll, describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const ENTITY_COUNT = 100_000;
const material = {
  baseColor: new Float32Array([0.25, 0.5, 0.75]),
  metallic: 0,
  roughness: 1,
  materialShaderId: 'forgeax::default-unlit',
} as MaterialSnapshot;

function snapshot(entityKey: number): RenderableSnapshot {
  return {
    assetHandle: 1,
    transform: { world: new Float32Array(mat4.identity(mat4.create())) },
    localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
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
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: '{"textures":[],"samplers":[],"video":[]}',
      },
    ],
  };
}

describe('GPU-driven scaling contract', () => {
  let projection: RenderScene;
  let topology: BatchTopology;
  let materialized: readonly RenderableSnapshot[];
  let stablePlan: ReturnType<BatchTopology['plan']>;
  let stableMaterializationReused = false;
  let stablePlanReused = false;
  let delta: ReturnType<RenderScene['apply']>;
  let topologyChanged = true;

  beforeAll(() => {
    projection = new RenderScene();
    projection.reset(Array.from({ length: ENTITY_COUNT }, (_, index) => snapshot(index)));
    materialized = projection.materialize();
    topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    stablePlan = topology.plan();
    stableMaterializationReused = projection.materialize() === materialized;
    stablePlanReused = topology.plan() === stablePlan;

    const moved = mat4.identity(mat4.create());
    moved[12] = 3;
    delta = projection.apply([
      { kind: 'update-transform', worldId: 0, entityKey: 50_000, world: moved },
    ]);
    topologyChanged = topology.apply(delta);
  });

  it('projects 100k candidates into one capacity-exact batch', () => {
    expect(stablePlan).toMatchObject({
      candidateCount: ENTITY_COUNT,
      visibleCapacity: ENTITY_COUNT,
      batches: [{ visibleCapacity: ENTITY_COUNT }],
    });
  });

  it('reuses materialization and topology identities while static', () => {
    expect(stableMaterializationReused).toBe(true);
    expect(stablePlanReused).toBe(true);
  });

  it('patches one transform without rebuilding topology', () => {
    expect(delta).toMatchObject({ updated: 1, created: 0, removed: 0 });
    expect(topologyChanged).toBe(false);
    expect(topology.plan()).toBe(stablePlan);
    expect(topology.inspect()).toMatchObject({ patches: 0, candidateCount: ENTITY_COUNT });
  });
});
