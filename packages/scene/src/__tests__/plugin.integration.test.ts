import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, scenePlugin, Transform } from '../index';

describe('scenePlugin', () => {
  it('installs propagation without render or animation capabilities', async () => {
    const world = new World();
    expect((await scenePlugin().build(world)).ok).toBe(true);
    const root = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(5);
  });
});
