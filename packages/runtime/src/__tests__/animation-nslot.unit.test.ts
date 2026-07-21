// feat-20260713-animation-state-machine-plugin M1 / w1 — variable N-slot lock.
//
// AC-01: AnimationPlayer.clips/times/weights/speeds drop the fixed 4-slot cap
// and become variable `array<T>` columns. This test constructs an entity with
// SIX concurrent slots, runs advanceAnimationPlayer for one frame, and asserts
// the read-back arrays keep length 6 with no overflow / truncation / throw.
//
// TDD red anchor: before the schema migration (w4), `clips` is
// `array<shared<AnimationClip>, 4>`; spawning a 6-element clips array trips the
// ECS `FixedArrayOverflowError` and `.unwrap()` throws — the construction
// itself fails. After w4 the variable schema accepts 6 slots and the frame
// leaves all six weight columns intact.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../components/animation-player';
import type { AnimationAssetResolver } from '../systems/advance-animation-player';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';

function makeClip(duration: number): AnimationClip {
  return { kind: 'animation-clip', duration, channels: [] };
}

function makeResolver(clips: Map<number, AnimationClip>): AnimationAssetResolver {
  return {
    resolveAnimationClip(_world: World, handleRaw: number): AnimationClip | undefined {
      return clips.get(handleRaw);
    },
  };
}

describe('AnimationPlayer — variable N-slot (M1 / w1)', () => {
  it('constructs and evaluates 6 concurrent slots without overflow / truncation', () => {
    const world = new World();
    const clipMap = new Map<number, AnimationClip>();
    for (let i = 1; i <= 6; i++) clipMap.set(i, makeClip(10));
    const resolver = makeResolver(clipMap);

    const clips = [1, 2, 3, 4, 5, 6].map((id) => toShared<'AnimationClip'>(id));
    const e = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips,
          times: new Float32Array([0, 0, 0, 0, 0, 0]),
          weights: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
          speeds: new Float32Array([1, 1, 1, 1, 1, 1]),
        },
      })
      .unwrap() as EntityHandle;

    expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();

    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
      clips: Uint32Array;
      weights: Float32Array;
    };
    // No 4-slot truncation: all six slots survive one frame.
    expect(ap.clips.length).toBe(6);
    expect(ap.weights.length).toBe(6);
    // advance never writes weights back (D-7); the six values read back verbatim.
    expect(Array.from(ap.weights)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
    ]);
    // The 6th clip handle is a real slot, not clamped away.
    expect(ap.clips[5]).toBe(toShared<'AnimationClip'>(6));
  });
});
