import { Entity, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from '../animation-target';

function spawnPlayer(world: World) {
  return world
    .spawn(
      { component: AnimationPlayer, data: {} },
      { component: AnimationTargets, data: {} },
      { component: Transform, data: {} },
    )
    .unwrap();
}

function spawnTarget(world: World) {
  return world
    .spawn(
      { component: AnimationTargetId, data: { value: 'a'.repeat(32) } },
      { component: Transform, data: {} },
    )
    .unwrap();
}

describe('animation target relationship', () => {
  it('declares an exclusive non-linked relationship', () => {
    expect(AnimationTargets.transient).toBe(true);
    expect(AnimationPlayer.fields.clips.simulationTransient).toBe(true);
    expect(AnimationPlayer.fields.graph.simulationTransient).toBe(true);
    expect(AnimatedBy.relationship).toEqual({
      mirror: 'AnimationTargets',
      field: 'targets',
      exclusive: true,
      linkedSpawn: false,
    });
  });

  it('keeps add, remove, rebind, and target despawn mirrors synchronized', () => {
    const world = new World();
    const first = spawnPlayer(world);
    const second = spawnPlayer(world);
    const target = spawnTarget(world);

    world.addComponent(target, { component: AnimatedBy, data: { player: first } }).unwrap();
    expect([...world.get(first, AnimationTargets).unwrap().targets]).toEqual([target]);

    world.addComponent(target, { component: AnimatedBy, data: { player: second } }).unwrap();
    expect([...world.get(first, AnimationTargets).unwrap().targets]).toEqual([]);
    expect([...world.get(second, AnimationTargets).unwrap().targets]).toEqual([target]);

    world.removeComponent(target, AnimatedBy).unwrap();
    expect([...world.get(second, AnimationTargets).unwrap().targets]).toEqual([]);

    world.addComponent(target, { component: AnimatedBy, data: { player: first } }).unwrap();
    world.despawn(target).unwrap();
    expect([...world.get(first, AnimationTargets).unwrap().targets]).toEqual([]);
  });

  it('does not despawn targets with the player and preserves a stale owner', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const target = spawnTarget(world);
    world.addComponent(target, { component: AnimatedBy, data: { player } }).unwrap();

    world.despawn(player).unwrap();

    expect(world.get(target, Entity).ok).toBe(true);
    expect(world.get(target, AnimatedBy).unwrap().player).toBe(player);
  });
});
