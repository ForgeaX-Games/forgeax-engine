// Multi-instance independence test (w30 M4 rewrite).

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

const Transform = defineComponent('Transform', {
  posX: { type: 'f32' },
  posY: { type: 'f32' },
  posZ: { type: 'f32' },
});
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

describe('SceneInstance multi-instance independence (w30 rewrite)', () => {
  it('two instantiateScene calls produce disjoint member entity sets', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r1 = world.instantiateScene(handle);
    const r2 = world.instantiateScene(handle);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const set1 = new Set<EntityHandle>(
      Array.from(world.getSceneInstanceState(r1.value.root).unwrap().entityToLocalId.keys()),
    );
    const set2 = new Set<EntityHandle>(
      Array.from(world.getSceneInstanceState(r2.value.root).unwrap().entityToLocalId.keys()),
    );

    for (const e of set1) expect(set2.has(e)).toBe(false);
    expect(set1.size).toBe(2);
    expect(set2.size).toBe(2);
  });

  it('setSceneOverride on instance A does not show up in instance B state.overrides', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r1 = world.instantiateScene(handle);
    const r2 = world.instantiateScene(handle);
    if (!r1.ok || !r2.ok) throw new Error('instantiateScene failed');

    const s1 = world.getSceneInstanceState(r1.value.root).unwrap();
    const s2 = world.getSceneInstanceState(r2.value.root).unwrap();
    const e1 = Array.from(s1.entityToLocalId.keys())[0];
    if (e1 === undefined) throw new Error('e1 missing');

    world.setSceneOverride(r1.value.root, e1, Transform, 'posX', 99).unwrap();
    expect(s1.overrides.size).toBe(1);
    expect(s2.overrides.size).toBe(0);
  });

  it('despawnScene on root1 leaves root2 alive', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r1 = world.instantiateScene(handle);
    const r2 = world.instantiateScene(handle);
    if (!r1.ok || !r2.ok) throw new Error('instantiateScene failed');

    world.despawnScene(r1.value.root).unwrap();

    const s2 = world.getSceneInstanceState(r2.value.root).unwrap();
    expect(s2.entityToLocalId.size).toBe(1);
    expect(s2.overrides.size).toBe(0);
    expect(s2.detachedLocalIds.size).toBe(0);
  });

  it('despawnScene on all roots under one handle leaves another handle intact', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handleA = registerSceneAsset(world, buildScene(nodes));
    const handleB = registerSceneAsset(world, buildScene(nodes));

    const rootA1 = world.instantiateScene(handleA).unwrap().root;
    const rootA2 = world.instantiateScene(handleA).unwrap().root;
    const rootB = world.instantiateScene(handleB).unwrap().root;

    world.despawnScene(rootA1).unwrap();
    world.despawnScene(rootA2).unwrap();

    const stateB = world.getSceneInstanceState(rootB).unwrap();
    expect(stateB.entityToLocalId.size).toBe(1);
  });
});
