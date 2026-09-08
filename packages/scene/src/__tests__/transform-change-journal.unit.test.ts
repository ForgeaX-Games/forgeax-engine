import { World } from '@forgeax/engine-ecs';
import { createWorldProjection } from '@forgeax/engine-ecs/projection';
import { describe, expect, it } from 'vitest';
import { ChildOf, propagateTransforms, Transform } from '../index';

describe('transform change journal', () => {
  it('drains a large derived publication without rebuilding on the next pass', () => {
    const world = new World();
    for (let index = 0; index <= 65_536; index += 1) {
      world.spawn({ component: Transform, data: {} }).unwrap();
    }

    const first = propagateTransforms(world);
    const second = propagateTransforms(world);

    expect(second).toBe(first);
  });

  it('publishes exactly the recomputed subtree and stays empty on no-change propagation', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const grandchild = world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        { component: ChildOf, data: { parent: child } },
      )
      .unwrap();
    const sibling = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();

    propagateTransforms(world).unwrap();
    const projection = createWorldProjection(world, { components: [Transform] });
    projection.poll();
    propagateTransforms(world).unwrap();
    expect(projection.poll()).toEqual({ status: 'delta', cursor: projection.cursor, changes: [] });

    world.set(child, Transform, { pos: [8, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    const changed = projection.poll();
    expect(changed.status).toBe('delta');
    if (changed.status !== 'delta') return;
    expect(
      changed.changes
        .filter(
          (record) => record.kind === 'derived-component-changed' && record.component === Transform,
        )
        .map((record) => record.entity),
    ).toEqual([child, grandchild]);
    expect(changed.changes.some((record) => record.entity === sibling)).toBe(false);
  });

  it('does not propagate again from derived Transform records', () => {
    const world = new World();
    world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();

    propagateTransforms(world).unwrap();
    const projection = createWorldProjection(world, { components: [Transform] });
    projection.poll();

    propagateTransforms(world).unwrap();

    expect(projection.poll()).toEqual({ status: 'delta', cursor: projection.cursor, changes: [] });
  });

  it('uses the final authored Transform state and skips an unchanged final state', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();

    propagateTransforms(world).unwrap();
    const projection = createWorldProjection(world, { components: [Transform] });
    projection.poll();

    world.set(root, Transform, { pos: [5, 0, 0] }).unwrap();
    world.set(root, Transform, { pos: [1, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    const unchanged = projection.poll();
    expect(unchanged.status).toBe('delta');
    if (unchanged.status !== 'delta') return;
    expect(
      unchanged.changes.filter((record) => record.kind === 'derived-component-changed'),
    ).toEqual([]);
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(3);

    world.set(root, Transform, { pos: [5, 0, 0] }).unwrap();
    world.set(root, Transform, { pos: [7, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    const changed = projection.poll();
    expect(changed.status).toBe('delta');
    if (changed.status !== 'delta') return;
    const derived = changed.changes.filter((record) => record.kind === 'derived-component-changed');
    expect(derived.map((record) => record.entity)).toEqual([root, child]);
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(9);
  });
});
