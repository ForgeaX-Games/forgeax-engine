import { World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from '../animation-target';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';

function animationCase(unrelatedSpawns: number) {
  const world = new World();
  for (const component of [
    Transform,
    GlobalTransform,
    AnimationPlayer,
    AnimatedBy,
    AnimationTargetId,
    AnimationTargets,
  ]) {
    world.components.register(component).unwrap();
  }
  const targetId = 'a95da0ec669189f98273e8f86d8ad9f2';
  const clip = world.allocSharedRef('AnimationClip', {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 4, 8, 12]),
          interpolation: 'LINEAR',
        },
      },
    ],
  });
  const player = world
    .spawn({
      component: AnimationPlayer,
      data: {
        clips: [clip],
        times: [1],
        speeds: [0],
        weights: [1],
        paused: true,
        looping: false,
      },
    })
    .unwrap();
  const target = world
    .spawn(
      { component: AnimationTargetId, data: { value: targetId } },
      { component: AnimatedBy, data: { player } },
    )
    .unwrap();
  advanceAnimationPlayer(world, 0); // Cache the target as lacking Transform.
  world.addComponent(target, { component: Transform, data: {} }).unwrap();
  for (let i = 0; i < unrelatedSpawns; i++) world.spawn().unwrap();
  advanceAnimationPlayer(world, 0);
  return {
    unrelatedSpawns,
    world,
    target,
    player,
    targetId,
    positionAfterAddingTransform: [...world.get(target, Transform).unwrap().pos],
  };
}

test.each([
  0, 1025,
])('observes added Transform independently of %i unrelated mutations', (count) => {
  expect(animationCase(count).positionAfterAddingTransform).toEqual([4, 8, 12]);
});

test('removed target IDs stop animation immediately and can be rebound', () => {
  const { world, target, targetId } = animationCase(0);
  world.removeComponent(target, AnimationTargetId).unwrap();
  world.set(target, Transform, { pos: [2, 3, 4] }).unwrap();
  advanceAnimationPlayer(world, 0);
  expect([...world.get(target, Transform).unwrap().pos]).toEqual([2, 3, 4]);
  world.addComponent(target, { component: AnimationTargetId, data: { value: targetId } }).unwrap();
  advanceAnimationPlayer(world, 0);
  expect([...world.get(target, Transform).unwrap().pos]).toEqual([4, 8, 12]);
});
