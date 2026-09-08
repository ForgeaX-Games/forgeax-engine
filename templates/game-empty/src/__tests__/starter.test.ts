import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Camera, renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createEmptyScene } from '../../assets/lib.js';
import gameplay from '../main.js';

describe('empty game starter', () => {
  it('starts with a valid empty SceneAsset', () => {
    expect(createEmptyScene()).toEqual({ kind: 'scene', entities: [] });
  });

  it('provides one disposable runtime camera without adding content to the scene asset', async () => {
    const world = new World();
    const context = await createWorldContext(world, [
      scenePlugin(),
      renderComponentsPlugin(),
      gameplay,
    ]);
    const query = world.query({ read: [Camera], with: [Transform] }).unwrap();
    const cameras = [...query].map((row) => row.entity);

    expect(cameras).toHaveLength(1);
    await context.fiber.dispose();
    expect(world.get(cameras[0]!, Camera).ok).toBe(false);
  });
});
