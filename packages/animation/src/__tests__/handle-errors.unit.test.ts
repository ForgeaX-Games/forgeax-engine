import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { resolveAnimationAsset } from '../resolve-animation-asset';

describe('animation handle failures', () => {
  it('keeps zero sentinel as a no-op', () => {
    const result = resolveAnimationAsset(new World(), 0, 'AnimationClip');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});
