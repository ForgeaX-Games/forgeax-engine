// SceneInstance write-path divergence: world.set vs world.setSceneOverride (w30 M4 rewrite).

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
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

describe('SceneInstance write-path divergence (AC-15)', () => {
  it('world.set on member entity mutates value but does NOT record into state.overrides', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;
    const state = world.getSceneInstanceState(root).unwrap();

    const entity = Array.from(state.entityToLocalId.keys())[0];
    if (entity === undefined) throw new Error('entity missing');

    world.set(entity, Transform, { posX: 7 }).unwrap();
    expect(world.get(entity, Transform).unwrap().posX).toBe(7);
    // raw ECS writes do NOT enter the override map
    expect(state.overrides.size).toBe(0);

    world.setSceneOverride(root, entity, Transform, 'posX', 9).unwrap();
    expect(world.get(entity, Transform).unwrap().posX).toBe(9);
    const lid = state.entityToLocalId.get(entity);
    if (lid === undefined) throw new Error('missing localId');
    const fieldMap = state.overrides.get(lid);
    expect(fieldMap?.size).toBe(1);
    expect(fieldMap?.get('Transform:posX')?.value).toBe(9);
  });

  it('mixing world.set and setSceneOverride: only setSceneOverride writes appear in state.overrides', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;
    const state = world.getSceneInstanceState(root).unwrap();
    const entity = Array.from(state.entityToLocalId.keys())[0];
    if (entity === undefined) throw new Error('entity missing');

    world.set(entity, Transform, { posX: 1 }).unwrap();
    world.setSceneOverride(root, entity, Transform, 'posY', 2).unwrap();
    world.set(entity, Transform, { posZ: 3 }).unwrap();
    world.setSceneOverride(root, entity, Transform, 'posX', 4).unwrap();

    const lid = state.entityToLocalId.get(entity);
    if (lid === undefined) throw new Error('missing localId');
    const fieldMap = state.overrides.get(lid);
    expect(fieldMap?.size).toBe(2);
    expect(fieldMap?.get('Transform:posY')?.value).toBe(2);
    expect(fieldMap?.get('Transform:posX')?.value).toBe(4);

    const t = world.get(entity, Transform).unwrap();
    expect(t.posX).toBe(4);
    expect(t.posY).toBe(2);
    expect(t.posZ).toBe(3);
  });
});
