import { resolveSkinJoints, Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

describe('skinning binding contract', () => {
  it('exposes Skin as the optional binding component', () => {
    expect(Skin.name).toBe('Skin');
    expect(Skin.schema.skeleton).toBe('shared<SkeletonAsset>');
    expect(Skin.schema.joints).toBe('array<entity>');
  });

  it('returns structured joint path failures', () => {
    const result = resolveSkinJoints(['Root/Missing'], new Map([['Root', 1 as never]]), 7 as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('skin-joint-path-unresolved');
    expect(result.error.hint).toContain('joint');
    expect(result.error.detail.skinEntity).toBe(7);
  });
});
