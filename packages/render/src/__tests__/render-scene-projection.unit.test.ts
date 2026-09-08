import { describe, expect, it } from 'vitest';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const material = {} as MaterialSnapshot;

function snapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 1,
    transform: { world },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

describe('RenderScene canonical owner', () => {
  it('coalesces create and transform updates into one stable slot', () => {
    const projection = new RenderScene();
    const initial = snapshot(7, 1);
    const updatedWorld = new Float32Array(initial.transform.world);
    updatedWorld[12] = 9;

    const result = projection.apply([
      { kind: 'create', snapshot: initial },
      { kind: 'update-transform', worldId: 0, entityKey: 7, world: updatedWorld },
    ]);

    expect(result).toMatchObject({ created: 1, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([
      expect.objectContaining({ slot: 0, generation: 0, worldId: 0, entityKey: 7 }),
    ]);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(9);
  });

  it('cancels a transient create/remove pair without allocating a slot', () => {
    const projection = new RenderScene();

    const result = projection.apply([
      { kind: 'create', snapshot: snapshot(3, 1) },
      { kind: 'remove', worldId: 0, entityKey: 3 },
    ]);

    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('bumps generation when remove and recreate reuse a slot', () => {
    const projection = new RenderScene();
    projection.apply([{ kind: 'create', snapshot: snapshot(5, 1) }]);
    const before = projection.inspect().records[0];

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 5 },
      { kind: 'create', snapshot: snapshot(5, 2) },
      { kind: 'update-transform', worldId: 0, entityKey: 5, world: snapshot(5, 7).transform.world },
    ]);

    const after = projection.inspect().records[0];
    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 1 });
    expect(after?.slot).toBe(before?.slot);
    expect(after?.generation).toBe((before?.generation ?? -1) + 1);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(7);
  });

  it('ignores an update that arrives after removal', () => {
    const projection = new RenderScene();
    projection.apply([{ kind: 'create', snapshot: snapshot(9, 1) }]);

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 9 },
      { kind: 'update-transform', worldId: 0, entityKey: 9, world: snapshot(9, 4).transform.world },
    ]);

    expect(result).toMatchObject({ removed: 1, ignoredLateUpdates: 1 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('keeps identical entity handles isolated by World identity', () => {
    const projection = new RenderScene();
    projection.apply([
      { kind: 'create', snapshot: snapshot(1, 3) },
      { kind: 'create', snapshot: { ...snapshot(1, 8), worldId: 1 } },
    ]);

    expect(projection.materialize().map((record) => record.transform.world[12])).toEqual([3, 8]);
  });
});

describe('RenderScene', () => {
  it('keeps world identity slots stable across a composition reorder', () => {
    const scene = new RenderScene();
    const first = snapshot(1, 3);
    const second = { ...snapshot(1, 8), worldId: 1 };

    scene.reset([first, second]);
    const before = scene.slot(0, 1);
    scene.reset([second, first]);

    expect(scene.slotsSnapshot().map((entry) => [entry.worldId, entry.entityKey])).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(scene.slot(0, 1)).toMatchObject({
      slot: before?.slot,
      generation: before?.generation,
    });
  });

  it('keeps one stable slot across reorder and reports no-change without scanning', () => {
    const scene = new RenderScene();
    scene.apply([
      { kind: 'create', snapshot: snapshot(7, 1) },
      { kind: 'create', snapshot: { ...snapshot(8, 2), worldId: 1 } },
    ]);

    const before = scene.slot(0, 7);
    scene.apply([]);
    const after = scene.slot(0, 7);

    expect(after).toMatchObject({ slot: before?.slot, generation: before?.generation });
    expect(scene.inspect()).toMatchObject({ noChangeFrames: 1, renderableScans: 0 });
  });

  it('indexes material and spatial facts from the same scene slots', () => {
    const scene = new RenderScene();
    scene.apply([
      {
        kind: 'create',
        snapshot: {
          ...snapshot(11, 4),
          localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
          material: { ...material, materialHandle: 42 },
          materials: [{ ...material, materialHandle: 42 }],
        },
      },
    ]);

    expect(scene.slotsForMaterial(42)).toHaveLength(1);
    expect(
      scene.querySpatial({ min: [2, -2, -2], max: [6, 2, 2] }).map((entry) => entry.entityKey),
    ).toEqual([11]);
  });

  it('rebuilds from a resync delta after journal overflow', () => {
    const scene = new RenderScene();
    scene.apply([{ kind: 'create', snapshot: snapshot(1, 0) }]);

    const result = scene.applyDelta({
      operations: [],
      overflowed: true,
      resync: [snapshot(99, 9)],
      reason: 'journal-overflow',
    });

    expect(result.resynced).toBe(1);
    expect(scene.has(0, 1)).toBe(false);
    expect(scene.has(0, 99)).toBe(true);
  });
});
