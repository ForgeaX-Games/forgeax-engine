import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { animationPlugin } from '../plugin';
import { resolveAnimationAsset } from '../resolve-animation-asset';

describe('animation resolver ownership', () => {
  it('builds and ticks without a runtime-provided resolver resource', async () => {
    const world = new World();
    const result = await animationPlugin().build(world);

    expect(result.ok).toBe(true);
    expect(world.hasResource('AnimationAssetResolver')).toBe(false);
    expect(() => world.update(1 / 60).unwrap()).not.toThrow();
  });

  it('reports a stale World-local animation handle from the animation owner', () => {
    const world = new World();
    const handle = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    });
    expect(world.sharedRefs.release(handle).ok).toBe(true);

    const result = resolveAnimationAsset(world, handle, 'animation-clip');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('animation-asset-stale');
      expect(result.error.detail.lookupCode).toBe('shared-ref-stale');
    }
  });
});
