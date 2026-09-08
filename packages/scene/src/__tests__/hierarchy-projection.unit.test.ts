import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../index';
import { projectHierarchy } from '../systems';
import { setMalformedParentEdge } from './fixtures/malformed-hierarchy-edge';

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
    const staleParent = world.spawn().unwrap();
    world.despawn(staleParent).unwrap();
    setMalformedParentEdge(world, child, staleParent);

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
    setMalformedParentEdge(world, self, self);
    setMalformedParentEdge(world, a, b);
    setMalformedParentEdge(world, b, c);
    setMalformedParentEdge(world, c, a);

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

  it('reuses a stable World projection and invalidates it after a hierarchy mutation', () => {
    const world = new World();
    const firstParent = world.spawn().unwrap();
    const secondParent = world.spawn().unwrap();
    const child = childOf(world, firstParent);

    const first = projectHierarchy(world);
    expect(projectHierarchy(world)).toBe(first);
    expect(first.getParent(child)).toBe(firstParent);

    world.set(child, ChildOf, { parent: secondParent }).unwrap();

    const second = projectHierarchy(world);
    expect(second).not.toBe(first);
    expect(second.getParent(child)).toBe(secondParent);
    expect(projectHierarchy(world)).toBe(second);
  });
});
