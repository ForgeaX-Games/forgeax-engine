// SceneInstance setSceneOverride / removeSceneOverride tests (w30 M4 rewrite).
// Tests the new World-level `setSceneOverride(root, member, comp, field, value)`
// and `removeSceneOverride(root, member, comp, field)` methods, accessed via
// `world.getSceneInstanceState(root)` for state inspection.

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

/** Get first member entity from root. */
function firstMember(world: World, root: EntityHandle): EntityHandle {
  const state = world.getSceneInstanceState(root).unwrap();
  const entries = Array.from(state.entityToLocalId.entries());
  const entry = entries[0];
  if (!entry) throw new Error('no member entity');
  return entry[0];
}

describe('SceneInstance setSceneOverride / removeSceneOverride (w30 rewrite)', () => {
  it('setSceneOverride writes to state.overrides and mutates world.get value', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;
    const state = world.getSceneInstanceState(root).unwrap();
    expect(state.overrides.size).toBe(0);

    const entity = firstMember(world, root);
    const setR = world.setSceneOverride(root, entity, Transform, 'posX', 5);
    expect(setR.ok).toBe(true);

    expect(world.get(entity, Transform).unwrap().posX).toBe(5);

    const lid = state.entityToLocalId.get(entity);
    if (lid === undefined) throw new Error('missing localId');
    const fieldMap = state.overrides.get(lid);
    expect(fieldMap?.size).toBe(1);
    const rec = fieldMap?.get('Transform:posX');
    expect(rec?.comp).toBe('Transform');
    expect(rec?.field).toBe('posX');
    expect(rec?.value).toBe(5);
  });

  it('removeSceneOverride drops diff and rewrites world value back to layer 1 explicit (0)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;
    const entity = firstMember(world, root);

    world.setSceneOverride(root, entity, Transform, 'posX', 5).unwrap();
    expect(world.get(entity, Transform).unwrap().posX).toBe(5);

    const remR = world.removeSceneOverride(root, entity, Transform, 'posX');
    expect(remR.ok).toBe(true);

    const state = world.getSceneInstanceState(root).unwrap();
    const lid = state.entityToLocalId.get(entity);
    if (lid === undefined) throw new Error('missing localId');
    // The field map entry is cleaned up after single-field removal.
    expect(state.overrides.get(lid)?.size ?? 0).toBe(0);

    expect(world.get(entity, Transform).unwrap().posX).toBe(0);
  });

  it('setSceneOverride with an entity NOT in the instance returns EcsError', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;

    const stray = world
      .spawn({ component: Transform, data: { posX: 11, posY: 22, posZ: 33 } })
      .unwrap();

    const setR = world.setSceneOverride(root, stray, Transform, 'posX', 99);
    expect(setR.ok).toBe(false);
    if (setR.ok) return;
    const e = setR.error as { code: string };
    expect(typeof e.code).toBe('string');
  });

  it('getSceneInstanceState surfaces source / entityToLocalId / overrides / detachedLocalIds / rootEntities', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 1, posY: 2, posZ: 3 } } },
      { localId: localId(1), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;
    const state = world.getSceneInstanceState(root).unwrap();

    expect(state.source).toBe(handle);
    expect(state.entityToLocalId.size).toBe(2);
    expect(state.overrides.size).toBe(0);
    expect(state.detachedLocalIds.size).toBe(0);
    expect(state.rootEntities.length).toBe(2);
  });

  it('setSceneOverride twice on the same field updates value in place (no duplicate)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value.root;
    const entity = firstMember(world, root);

    world.setSceneOverride(root, entity, Transform, 'posX', 1).unwrap();
    world.setSceneOverride(root, entity, Transform, 'posX', 7).unwrap();

    const state = world.getSceneInstanceState(root).unwrap();
    const lid = state.entityToLocalId.get(entity);
    if (lid === undefined) throw new Error('missing localId');
    const fieldMap = state.overrides.get(lid);
    expect(fieldMap?.size).toBe(1);
    expect(fieldMap?.get('Transform:posX')?.value).toBe(7);
    expect(world.get(entity, Transform).unwrap().posX).toBe(7);
  });
});
