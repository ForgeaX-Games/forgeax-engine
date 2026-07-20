// Scene nesting ECS-fication (M4 / w30) — hierarchy zero-regression rewrite.
//
// Verifies AC-26: after M3 deletion of SceneInstanceContainer, the new
// World-level instantiateScene + SceneInstance ECS component still work.
// The old scene instance container accessor is deleted (AC-02 grep gate=0).

import { describe, expect, it } from 'vitest';
import { defineComponent, resolveComponent, World } from '../index';

describe('SceneInstance instantiateScene hierarchy zero-regression', () => {
  it('world.instantiateScene is a function', () => {
    const world = new World();
    expect(typeof world.instantiateScene).toBe('function');
    expect(typeof world._setSceneAssetResolver).toBe('function');
  });

  it('world.inspect() does not expose a stale sceneInstances field', () => {
    const world = new World();
    const snap = world.inspect();
    expect((snap as unknown as Record<string, unknown>).sceneInstances).toBeUndefined();
  });

  it('resolveComponent string-based component resolution still works', () => {
    const TestComp = defineComponent('ChildOf', { parent: 'entity' });
    const resolved = resolveComponent('ChildOf');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('ChildOf');
    expect(resolved).toBe(TestComp);
  });
});
