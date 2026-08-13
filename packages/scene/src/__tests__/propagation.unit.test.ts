import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, propagateTransforms, Transform } from '../index';
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

  it('keeps equal entity handles isolated across Worlds', () => {
    const first = new World();
    const second = new World();
    const firstRoot = first.spawn({ component: Transform, data: { pos: [3, 0, 0] } }).unwrap();
    const secondRoot = second.spawn({ component: Transform, data: { pos: [7, 0, 0] } }).unwrap();

    expect(firstRoot).toBe(secondRoot);
    expect(propagateTransforms(first).ok).toBe(true);
    expect(propagateTransforms(second).ok).toBe(true);
    expect(first.get(firstRoot, Transform).unwrap().world[12]).toBeCloseTo(3);
    expect(second.get(secondRoot, Transform).unwrap().world[12]).toBeCloseTo(7);
  });

  it('reuses a stable propagation result and invalidates it after a local edit', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();

    const first = propagateTransforms(world);
    const second = propagateTransforms(world);
    expect(first).toBe(second);
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(5);

    world.set(root, Transform, { pos: [7, 0, 0] }).unwrap();
    const third = propagateTransforms(world);
    expect(third).not.toBe(second);
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(10);
  });
});
