// scene-instantiate-typo.test - AC-08(b) e2e fail-fast for typo field names
// (M4 / w30 rewrite).

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

defineComponent('Transform', { posX: 'f32', posY: 'f32', posZ: 'f32' });
defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function buildScene(nodes: readonly SceneEntity[]): SceneAsset {
  return { kind: 'scene', entities: nodes };
}

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('instantiateScene - typo field fail-fast (AC-08(b))', () => {
  it('still accepts a valid SceneAsset with no typo fields (regression guard)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 2, posZ: 3 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    // 2 node entities + 1 synthetic root = 3 total
    expect(world.inspect().entityCount).toBe(3);
  });
});
