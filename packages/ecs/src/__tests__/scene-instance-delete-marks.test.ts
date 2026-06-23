// SceneInstance detachSceneMember / reattachSceneMember + despawnScene tests (w30 M4 rewrite).

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { entityIndex } from '../entity-handle';
import { World } from '../world';
import { handleNumeric } from './utils/handle-numeric';

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

function isLiveWithTransform(world: World, e: number): boolean {
  return world.get(e as Parameters<typeof world.get>[0], Transform).ok;
}

describe('SceneInstance detachSceneMember / reattachSceneMember (w30 rewrite)', () => {
  it('detachSceneMember writes detachedLocalIds but does NOT despawn the entity', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
      { localId: localId(2), components: { Transform: { posX: 2, posY: 2, posZ: 2 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value;
    const state = world.getSceneInstanceState(root).unwrap();
    expect(state.detachedLocalIds.size).toBe(0);

    // Get the member entity for localId(2) via reverse lookup
    let target: EntityHandle | undefined;
    for (const [e, lid] of state.entityToLocalId) {
      if (lid === localId(2)) {
        target = e;
        break;
      }
    }
    expect(target).toBeDefined();
    if (target === undefined) return;

    world.detachSceneMember(root, target).unwrap();
    expect(state.detachedLocalIds.has(localId(2))).toBe(true);
    expect(state.detachedLocalIds.size).toBe(1);
    expect(isLiveWithTransform(world, handleNumeric(target))).toBe(true);
    expect(typeof entityIndex(target)).toBe('number');
  });

  it('reattachSceneMember drops the mark', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value;
    const state = world.getSceneInstanceState(root).unwrap();
    const entity = Array.from(state.entityToLocalId.keys())[0];
    if (entity === undefined) throw new Error('entity missing');

    world.detachSceneMember(root, entity).unwrap();
    expect(state.detachedLocalIds.has(localId(0))).toBe(true);

    world.reattachSceneMember(root, entity).unwrap();
    expect(state.detachedLocalIds.size).toBe(0);
  });

  it('detachSceneMember with an entity NOT in the instance is a noop ok-result', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value;
    const stray = world
      .spawn({ component: Transform, data: { posX: 99, posY: 99, posZ: 99 } })
      .unwrap();
    const remR = world.detachSceneMember(root, stray);
    expect(remR.ok).toBe(true);
  });

  it('detachSceneMember twice on the same entity is idempotent', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value;
    const state = world.getSceneInstanceState(root).unwrap();
    const entity = Array.from(state.entityToLocalId.keys())[0];
    if (entity === undefined) throw new Error('entity missing');

    world.detachSceneMember(root, entity).unwrap();
    world.detachSceneMember(root, entity).unwrap();
    expect(state.detachedLocalIds.size).toBe(1);
  });

  it('reattachSceneMember on an entity that was never detached is a noop ok-result', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const root = r.value;
    const state = world.getSceneInstanceState(root).unwrap();
    const entity = Array.from(state.entityToLocalId.keys())[0];
    if (entity === undefined) throw new Error('entity missing');

    world.reattachSceneMember(root, entity).unwrap();
    expect(state.detachedLocalIds.size).toBe(0);
  });
});

describe('despawnScene (w30 rewrite)', () => {
  it('despawnScene destroys every member entity (no detach)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
      { localId: localId(2), components: { Transform: { posX: 2, posY: 2, posZ: 2 } } },
      { localId: localId(3), components: { Transform: { posX: 3, posY: 3, posZ: 3 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value;
    const entities = Array.from(world.getSceneInstanceState(root).unwrap().entityToLocalId.keys());
    expect(entities.length).toBe(4);
    for (const e of entities) {
      expect(isLiveWithTransform(world, handleNumeric(e))).toBe(true);
    }

    const despawnR = world.despawnScene(root);
    expect(despawnR.ok).toBe(true);

    for (const e of entities) {
      const r2 = world.get(handleNumeric(e) as Parameters<typeof world.get>[0], Transform);
      expect(r2.ok).toBe(false);
    }
  });

  it('despawnScene on already-despawned entities is ok (idempotent stale)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
      { localId: localId(2), components: { Transform: { posX: 2, posY: 2, posZ: 2 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value;
    const state = world.getSceneInstanceState(root).unwrap();
    const all = Array.from(state.entityToLocalId.keys());

    // Manually despawn one node first.
    const e0 = all[0];
    if (e0 === undefined) return;
    expect(world.despawn(e0).ok).toBe(true);

    const despawnR = world.despawnScene(root);
    expect(despawnR.ok).toBe(true);

    for (const e of all) {
      const r2 = world.get(handleNumeric(e) as Parameters<typeof world.get>[0], Transform);
      expect(r2.ok).toBe(false);
    }
  });
});
