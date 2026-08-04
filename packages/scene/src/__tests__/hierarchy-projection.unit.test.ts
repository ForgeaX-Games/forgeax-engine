import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../index';
import { projectHierarchy } from '../systems';

function setParent(world: World, child: EntityHandle, parent: EntityHandle): void {
  const graph = (
    world as unknown as {
      _getGraph(): {
        archetypes: ReadonlyArray<
          | {
              size: number;
              columns: Map<number, Map<string, { view: Uint32Array }>>;
            }
          | undefined
        >;
      };
    }
  )._getGraph();
  for (const archetype of graph.archetypes) {
    if (archetype === undefined) continue;
    const entities = archetype.columns.get(Entity.id)?.get('self')?.view;
    const parents = archetype.columns.get(ChildOf.id)?.get('parent')?.view;
    if (entities === undefined || parents === undefined) continue;
    for (let row = 0; row < archetype.size; row++) {
      if (entities[row] === child) parents[row] = parent;
    }
  }
}

function childOf(world: World, parent: EntityHandle): EntityHandle {
  return world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
    .unwrap();
}

describe('scene hierarchy projection', () => {
  it('keeps a live parent edge even when the parent has no Transform', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = childOf(world, parent);

    const snapshot = projectHierarchy(world);

    expect(snapshot.getParent(child)).toBe(parent);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('cuts a stale parent edge and reports a machine-readable diagnostic', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = childOf(world, parent);
    const staleParent = 0xffffffff as EntityHandle;
    setParent(world, child, staleParent);

    const snapshot = projectHierarchy(world);
    const diagnostic = snapshot.diagnostics[0];

    expect(snapshot.getParent(child)).toBeUndefined();
    expect(diagnostic?.code).toBe('hierarchy-broken');
    expect(diagnostic?.detail.entity).toBe(child);
    expect(diagnostic?.detail.parent).toBe(staleParent);
    expect(diagnostic?.expected).toContain('live entity');
    expect(diagnostic?.hint.length).toBeGreaterThan(0);
  });

  it('terminates self and multi-member cycles and sorts diagnostics by entity', () => {
    const world = new World();
    const self = childOf(world, world.spawn().unwrap());
    const a = childOf(world, world.spawn().unwrap());
    const b = childOf(world, world.spawn().unwrap());
    const c = childOf(world, world.spawn().unwrap());
    setParent(world, self, self);
    setParent(world, a, b);
    setParent(world, b, c);
    setParent(world, c, a);

    const snapshot = projectHierarchy(world);
    const cycleDiagnostics = snapshot.diagnostics.filter((item) => item.code === 'hierarchy-cycle');
    const diagnosticEntities = cycleDiagnostics.map((item) => item.detail.entity);

    expect(snapshot.getParent(self)).toBeUndefined();
    expect(snapshot.getParent(a)).toBeUndefined();
    expect(snapshot.getParent(b)).toBeUndefined();
    expect(snapshot.getParent(c)).toBeUndefined();
    expect(cycleDiagnostics).toHaveLength(4);
    expect(diagnosticEntities).toEqual([...diagnosticEntities].sort((x, y) => x - y));
    expect(cycleDiagnostics.every((item) => item.detail.parent !== undefined)).toBe(true);
  });

  it('does not invent a parent edge for a root entity', () => {
    const world = new World();
    const root = world.spawn().unwrap();

    expect(projectHierarchy(world).getParent(root)).toBeUndefined();
  });
});
