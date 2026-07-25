import { postSpawnResolveJoints } from '@forgeax/engine-render/internal';
import { describe, expect, it } from 'vitest';

describe('scene instance skin bridge', () => {
  it('exports a post-spawn resolver for nested mounts', () => {
    expect(typeof postSpawnResolveJoints).toBe('function');
  });
});
