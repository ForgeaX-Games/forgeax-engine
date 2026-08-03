import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue, Handle } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, AnimationTargets } from '../animation-target';
import { animationPlugin } from '../plugin';
import { _resetAnimationWarnsForTests } from '../systems/advance-animation-player';

const TARGET_ID = 'a95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;

function clip(targetId = TARGET_ID): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 1, 1, 1]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

async function playerWithClip(world: World, animationClip = clip()): Promise<EntityHandle> {
  expect((await animationPlugin().build(world)).ok).toBe(true);
  const handle = world.allocSharedRef('AnimationClip', animationClip);
  return world
    .spawn({
      component: AnimationPlayer,
      data: { clips: [handle], times: [0], weights: [1], speeds: [1] },
    })
    .unwrap() as EntityHandle;
}

function diagnostics(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call: unknown[]) => call[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('animation runtime diagnostics', () => {
  it('emits a readonly structured missing-target diagnostic once per full tuple and World', async () => {
    const first = new World();
    const second = new World();
    const firstPlayer = await playerWithClip(first);
    await playerWithClip(second);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    first.update(0.25);
    first.update(0.25);
    second.update(0.25);

    expect(diagnostics(warn)).toHaveLength(2);
    expect(diagnostics(warn)[0]).toEqual({
      code: 'animation-target-missing',
      hint: expect.any(String),
      detail: {
        player: firstPlayer as number,
        clip: expect.any(Number),
        channel: 0,
        targetId: TARGET_ID,
        reason: 'target-missing',
      },
    });
    expect(Object.isFrozen(diagnostics(warn)[0])).toBe(true);

    _resetAnimationWarnsForTests(first);
    first.update(0.25);
    expect(diagnostics(warn)).toHaveLength(3);
  });

  it('emits structured diagnostics for missing Transform, duplicate IDs, stale targets, and missing channels', async () => {
    const world = new World();
    const player = await playerWithClip(world);
    const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world
      .addComponent(player, { component: AnimationTargets, data: { targets: [target] } })
      .unwrap();
    world.removeComponent(target, Transform).unwrap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.25);

    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-transform-missing',
        detail: expect.objectContaining({ reason: 'transform-missing', targetId: TARGET_ID }),
      }),
    );

    world.addComponent(target, { component: Transform, data: {} }).unwrap();
    const duplicate = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(duplicate, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world.set(player, AnimationTargets, { targets: [target, duplicate] }).unwrap();
    world.update(0.25);
    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-id-duplicate',
        detail: expect.objectContaining({ reason: 'target-id-duplicate', targetId: TARGET_ID }),
      }),
    );

    world.despawn(duplicate).unwrap();
    world.set(player, AnimationTargets, { targets: [duplicate] }).unwrap();
    world.update(0.25);
    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-owner-stale',
        detail: expect.objectContaining({ reason: 'target-stale', targetId: TARGET_ID }),
      }),
    );

    const secondClip: AnimationClip = { kind: 'animation-clip', duration: 1, channels: [] };
    const secondHandle = world.allocSharedRef('AnimationClip', secondClip);
    world.set(player, AnimationTargets, { targets: [target] }).unwrap();
    world.set(player, AnimationPlayer, {
      clips: [
        world.get(player, AnimationPlayer).unwrap().clips[0] as unknown as Handle<
          'AnimationClip',
          'shared'
        >,
        secondHandle,
      ],
      times: [0, 0],
      weights: [1, 1],
      speeds: [1, 1],
    });
    world.update(0.25);
    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-channel-missing',
        detail: expect.objectContaining({ reason: 'channel-missing', targetId: TARGET_ID }),
      }),
    );
  });

  it('emits no diagnostic in production', async () => {
    const proc = globalThis as { process?: { env: { NODE_ENV?: string } } };
    const saved = proc.process?.env.NODE_ENV;
    if (proc.process !== undefined) proc.process.env.NODE_ENV = 'production';
    try {
      const world = new World();
      await playerWithClip(world);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      world.update(0.25);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (proc.process !== undefined) {
        if (saved === undefined) delete proc.process.env.NODE_ENV;
        else proc.process.env.NODE_ENV = saved;
      }
    }
  });
});
