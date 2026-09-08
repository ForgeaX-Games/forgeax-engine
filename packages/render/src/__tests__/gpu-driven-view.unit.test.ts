import { frustum, mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { classifyGpuDrivenView } from './gpu-driven-view-reference';

const material = {
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot;

function snapshot(entityKey: number, x: number, resourceClass = 'plain'): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    assetHandle: 7,
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
        materialResourceClass: resourceClass,
      },
    ],
  };
}

describe('GPU-driven batch topology and CPU oracle', () => {
  it('patches topology only when compatibility membership changes', () => {
    const projection = new RenderScene();
    projection.apply([
      { kind: 'create', snapshot: snapshot(1, 0) },
      { kind: 'create', snapshot: snapshot(2, 0.5) },
      { kind: 'create', snapshot: snapshot(3, 0, 'textured') },
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.inspect()).toMatchObject({ batchCount: 2, candidateCount: 3, rebuilds: 1 });
    expect(topology.plan()).toBe(topology.plan());

    const transformOnly = projection.apply([
      {
        kind: 'update-transform',
        worldId: 0,
        entityKey: 1,
        world: snapshot(1, 0.25).transform.world,
      },
    ]);
    expect(topology.apply(transformOnly)).toBe(false);
    expect(topology.plan()).toBe(topology.plan());
    expect(topology.inspect().patches).toBe(0);

    const removed = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]);
    expect(topology.apply(removed)).toBe(true);
    expect(topology.inspect()).toMatchObject({ batchCount: 1, candidateCount: 2, patches: 1 });
  });

  it('compacts visible primitive indices and writes portable indexed indirect args', () => {
    const projection = new RenderScene();
    projection.apply([
      { kind: 'create', snapshot: snapshot(1, 0) },
      { kind: 'create', snapshot: snapshot(2, 10) },
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const result = classifyGpuDrivenView(topology.plan(), projection.slotsSnapshot(), planes);

    expect(result).toMatchObject({
      candidateCount: 2,
      rejectedCount: 1,
      visibleCount: 1,
      overflowedBatches: [],
    });
    expect([...result.visibleInstanceIndices]).toEqual([0, 0]);
    expect([...result.batchCounters]).toEqual([1]);
    const args = new DataView(result.indirectArgs);
    expect(args.getUint32(0, true)).toBe(36);
    expect(args.getUint32(4, true)).toBe(1);
    expect(args.getUint32(8, true)).toBe(3);
    expect(args.getInt32(12, true)).toBe(-2);
    expect(args.getUint32(16, true)).toBe(0);
  });

  it('keeps multi-submesh draw items independent and writes non-indexed indirect args', () => {
    const projection = new RenderScene();
    const source = snapshot(1, 0);
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    projection.apply([
      {
        kind: 'create',
        snapshot: {
          ...source,
          gpuDrivenDraws: [
            { ...first, kind: 'non-indexed', first: 0, count: 3 },
            { ...first, kind: 'non-indexed', first: 3, count: 6 },
          ],
        },
      },
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const plan = topology.plan();
    expect(plan).toMatchObject({ candidateCount: 2, batches: [{}, {}] });
    const result = classifyGpuDrivenView(
      plan,
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    const firstArgs = new DataView(result.indirectArgs, plan.batches[0]?.indirectOffset ?? 0, 20);
    const secondArgs = new DataView(result.indirectArgs, plan.batches[1]?.indirectOffset ?? 0, 20);
    expect([firstArgs.getUint32(0, true), firstArgs.getUint32(8, true)]).toEqual([3, 0]);
    expect([secondArgs.getUint32(0, true), secondArgs.getUint32(8, true)]).toEqual([6, 3]);
    expect(firstArgs.getUint32(12, true)).toBe(0);
    expect(secondArgs.getUint32(12, true)).toBe(0);
  });

  it('culls ordinary instance-local transforms and emits instance identities', () => {
    const source = snapshot(1, 0);
    const identity = mat4.identity(mat4.create());
    const outside = mat4.identity(mat4.create());
    outside[12] = 10;
    const projection = new RenderScene();
    projection.apply([
      {
        kind: 'create',
        snapshot: {
          ...source,
          instances: {
            transforms: new Float32Array([...identity, ...outside]),
            instanceCount: 2,
            cacheKey: 1,
            archVersion: 1,
          },
        },
      },
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.inspect()).toMatchObject({ candidateCount: 2, ineligible: 0 });
    const result = classifyGpuDrivenView(
      topology.plan(),
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    expect(result).toMatchObject({ candidateCount: 2, visibleCount: 1, rejectedCount: 1 });
    expect([...result.visibleInstanceIndices]).toEqual([0, 0]);
    expect(new DataView(result.indirectArgs).getUint32(4, true)).toBe(1);
  });

  it('reports overflow instead of silently accepting a truncated batch', () => {
    const projection = new RenderScene();
    projection.apply([
      { kind: 'create', snapshot: snapshot(1, 0) },
      { kind: 'create', snapshot: snapshot(2, 0.5) },
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const plan = topology.plan();
    const batch = plan.batches[0];
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    const result = classifyGpuDrivenView(
      plan,
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      new Map([[batch.batchId, 1]]),
    );
    expect(result.overflowedBatches).toEqual([batch.batchId]);
    expect(result.visibleCount).toBe(1);
  });

  it('keeps the ineligible inspection bounded to current projection membership', () => {
    const projection = new RenderScene();
    const { localAabb: _localAabb, ...withoutBounds } = snapshot(1, 0);
    const topology = new BatchTopology();
    topology.rebuild(projection.apply([{ kind: 'create', snapshot: withoutBounds }]).createdSlots);
    expect(topology.inspect().ineligible).toBe(1);

    const removed = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    topology.apply(removed);
    expect(topology.inspect().ineligible).toBe(0);
  });
});
