import { type EntityHandle, err, ManagedBufferOutOfBoundsError, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import {
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
  bindAnimationTargets,
} from '../animation-target';
import { deriveAnimationTargetId } from '../target-id';

function spawnPlayer(world: World, withMirror = true) {
  if (!withMirror) {
    return world
      .spawn(
        { component: AnimationPlayer, data: {} },
        { component: Transform, data: {} },
        { component: Name, data: { value: 'Root' } },
      )
      .unwrap();
  }
  return world
    .spawn(
      { component: AnimationPlayer, data: {} },
      { component: Transform, data: {} },
      { component: Name, data: { value: 'Root' } },
      { component: AnimationTargets, data: {} },
    )
    .unwrap();
}

function spawnTarget(world: World, player: EntityHandle, name = 'Target') {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: Name, data: { value: name } },
      { component: ChildOf, data: { parent: player } },
    )
    .unwrap();
}

function expectBindCode(result: ReturnType<typeof bindAnimationTargets>, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.hint.length).toBeGreaterThan(0);
  expect(result.error.detail).toBeDefined();
}

describe('bindAnimationTargets', () => {
  it('derives missing IDs, preserves existing IDs, and is idempotent', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const derived = spawnTarget(world, player, 'Hip');
    const existing = spawnTarget(world, player, 'Hand');
    const existingId = deriveAnimationTargetId(['authored', 'hand']);
    world
      .addComponent(existing, { component: AnimationTargetId, data: { value: existingId } })
      .unwrap();
    world.removeComponent(existing, Name).unwrap();

    expect(bindAnimationTargets(world, player, [derived, existing]).ok).toBe(true);
    expect(world.get(derived, AnimationTargetId).unwrap().value).toBe(
      deriveAnimationTargetId(['Root', 'Hip']),
    );
    expect(world.get(existing, AnimationTargetId).unwrap().value).toBe(existingId);
    expect(world.get(derived, AnimatedBy).unwrap().player).toBe(player);
    expect(world.get(existing, AnimatedBy).unwrap().player).toBe(player);
    expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual([derived, existing]);

    const beforeCapacity = world.capacity(player, AnimationTargets, 'targets').unwrap();
    expect(bindAnimationTargets(world, player, [existing, derived, existing]).ok).toBe(true);
    expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual([derived, existing]);
    expect(world.capacity(player, AnimationTargets, 'targets').unwrap()).toBe(beforeCapacity);
  });

  it('creates a missing mirror and replaces a stale owner', () => {
    const world = new World();
    const player = spawnPlayer(world, false);
    const staleOwner = spawnPlayer(world);
    const target = spawnTarget(world, player);
    world.addComponent(target, { component: AnimatedBy, data: { player: staleOwner } }).unwrap();
    world.despawn(staleOwner).unwrap();

    expect(bindAnimationTargets(world, player, [target]).ok).toBe(true);
    expect(world.get(target, AnimatedBy).unwrap().player).toBe(player);
    expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual([target]);
  });

  it('reports invalid player, target, hierarchy, and missing-name failures', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const invalidPlayer = world.spawn({ component: Transform, data: {} }).unwrap();
    const outside = world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: 'Outside' } })
      .unwrap();
    const noName = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: player } })
      .unwrap();
    const stale = spawnTarget(world, player);
    world.despawn(stale).unwrap();

    expectBindCode(
      bindAnimationTargets(world, invalidPlayer, []),
      'animation-target-player-invalid',
    );
    expectBindCode(bindAnimationTargets(world, player, [stale]), 'animation-target-invalid');
    expectBindCode(
      bindAnimationTargets(world, player, [outside]),
      'animation-target-outside-player-root',
    );
    expectBindCode(bindAnimationTargets(world, player, [noName]), 'animation-target-name-missing');
  });

  it('reports duplicate IDs, owner conflicts, and invalid ID wires', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const otherPlayer = spawnPlayer(world);
    const first = spawnTarget(world, player, 'First');
    const second = spawnTarget(world, player, 'Second');
    const duplicate = deriveAnimationTargetId(['duplicate']);
    world
      .addComponent(first, { component: AnimationTargetId, data: { value: duplicate } })
      .unwrap();
    world
      .addComponent(second, { component: AnimationTargetId, data: { value: duplicate } })
      .unwrap();
    expectBindCode(
      bindAnimationTargets(world, player, [first, second]),
      'animation-target-id-duplicate',
    );

    world.removeComponent(second, AnimationTargetId).unwrap();
    world.addComponent(second, { component: AnimatedBy, data: { player: otherPlayer } }).unwrap();
    expectBindCode(
      bindAnimationTargets(world, player, [second]),
      'animation-target-player-conflict',
    );

    world.removeComponent(second, AnimatedBy).unwrap();
    world
      .addComponent(second, { component: AnimationTargetId, data: { value: 'not-a-target-id' } })
      .unwrap();
    expectBindCode(bindAnimationTargets(world, player, [second]), 'animation-target-id-invalid');
  });

  it('rejects an ID already bound to another live target without changing the world', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const first = spawnTarget(world, player, 'First');
    const second = spawnTarget(world, player, 'Second');
    const duplicate = deriveAnimationTargetId(['duplicate']);
    world
      .addComponent(first, { component: AnimationTargetId, data: { value: duplicate } })
      .unwrap();
    world
      .addComponent(second, { component: AnimationTargetId, data: { value: duplicate } })
      .unwrap();
    expect(bindAnimationTargets(world, player, [first]).ok).toBe(true);
    const beforeTargets = [...world.get(player, AnimationTargets).unwrap().targets];
    const beforeCapacity = world.capacity(player, AnimationTargets, 'targets').unwrap();
    const beforeTicks = { ...world._getComponentChange(player, AnimationTargets.id) };

    expectBindCode(bindAnimationTargets(world, player, [second]), 'animation-target-id-duplicate');

    expect(world.get(first, AnimatedBy).unwrap().player).toBe(player);
    expect(world.get(second, AnimatedBy).ok).toBe(false);
    expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual(beforeTargets);
    expect(world.capacity(player, AnimationTargets, 'targets').unwrap()).toBe(beforeCapacity);
    expect(world._getComponentChange(player, AnimationTargets.id)).toEqual(beforeTicks);
  });

  it('leaves IDs, owners, mirror, capacity, and changed state untouched on reserve failure', () => {
    const world = new World();
    const player = spawnPlayer(world);
    const first = spawnTarget(world, player, 'First');
    const second = spawnTarget(world, player, 'Second');
    const beforeTargets = [...world.get(player, AnimationTargets).unwrap().targets];
    const beforeCapacity = world.capacity(player, AnimationTargets, 'targets').unwrap();
    const beforeTicks = { ...world._getComponentChange(player, AnimationTargets.id) };
    const reserve = vi
      .spyOn(world, 'reserveArrayCapacity')
      .mockReturnValue(err(new ManagedBufferOutOfBoundsError(70_000, 65_536)));

    const result = bindAnimationTargets(world, player, [first, second]);

    expect(result.ok).toBe(false);
    expect(world.get(first, AnimationTargetId).ok).toBe(false);
    expect(world.get(second, AnimationTargetId).ok).toBe(false);
    expect(world.get(first, AnimatedBy).ok).toBe(false);
    expect(world.get(second, AnimatedBy).ok).toBe(false);
    expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual(beforeTargets);
    expect(world.capacity(player, AnimationTargets, 'targets').unwrap()).toBe(beforeCapacity);
    expect(world._getComponentChange(player, AnimationTargets.id)).toEqual(beforeTicks);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('keeps a missing mirror absent on reserve failure', () => {
    const world = new World();
    const player = spawnPlayer(world, false);
    const target = spawnTarget(world, player);
    const beforeMirror = world.get(player, AnimationTargets);
    const beforeCapacity = world.capacity(player, AnimationTargets, 'targets');
    const beforeTicks = world._getComponentChange(player, AnimationTargets.id);
    const reserve = vi
      .spyOn(world, 'reserveArrayCapacity')
      .mockReturnValue(err(new ManagedBufferOutOfBoundsError(70_000, 65_536)));

    const result = bindAnimationTargets(world, player, [target]);

    expect(result.ok).toBe(false);
    expect(world.get(target, AnimationTargetId).ok).toBe(false);
    expect(world.get(target, AnimatedBy).ok).toBe(false);
    expect(world.get(player, AnimationTargets).ok).toBe(beforeMirror.ok);
    expect(world.capacity(player, AnimationTargets, 'targets').ok).toBe(beforeCapacity.ok);
    expect(world._getComponentChange(player, AnimationTargets.id)).toBe(beforeTicks);
    expect(reserve).toHaveBeenCalledOnce();
  });
});
