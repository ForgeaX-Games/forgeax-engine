import { defineComponent, World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, worldDespawnScene, worldInstantiateScenePayload } from '../index';

const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});
const SceneMarker = defineComponent('ScenePayloadMarker', { value: 'i32' });

function registerSceneWorld(world: World): void {
  for (const component of [SceneInstance, ChildOf, Children, SceneMarker]) {
    world.components.register(component).unwrap();
  }
}

function scene(): SceneAsset {
  return {
    kind: 'scene',
    entities: [
      {
        localId: 0 as never,
        components: { ScenePayloadMarker: { value: 7 } },
      },
    ],
  };
}

describe('scene payload ownership', () => {
  it('retains the payload for the mounted instance and releases it on despawn', () => {
    const world = new World();
    registerSceneWorld(world);

    const result = worldInstantiateScenePayload(world, scene());

    expect(result.ok).toBe(true);
    expect(world.sharedRefs._liveCount()).toBe(1);
    if (!result.ok) return;
    expect(worldDespawnScene(world, result.value.root).ok).toBe(true);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it('releases the temporary producer grant when materialisation fails', () => {
    const world = new World();
    registerSceneWorld(world);

    const result = worldInstantiateScenePayload(world, {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { MissingComponent: { value: 1 } } }],
    } as SceneAsset);

    expect(result.ok).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
});
