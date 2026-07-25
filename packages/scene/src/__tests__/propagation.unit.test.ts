import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../index';
import { registerPropagateTransforms } from '../systems';

describe('scene propagation', () => {
  it('propagates a root and child in a headless world', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const root = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(true);
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(5);
  });

  it('cascades linked children when a parent is despawned', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();
    world.despawn(parent);
    const result = world.update(1 / 60);
    expect(result.ok).toBe(true);
    expect(world.get(child, Transform).ok).toBe(false);
  });
});
