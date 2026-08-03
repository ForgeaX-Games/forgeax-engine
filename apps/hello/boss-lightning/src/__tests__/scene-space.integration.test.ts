import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { toShared } from '@forgeax/engine-types';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { particleSceneSpaceResolver } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';
import { createBossScene } from '../scene';

describe('Boss Lightning scene-space joint', () => {
  it('resolves the authored mouth child through the scene hierarchy', async () => {
    const world = new World();
    const material = toShared<'MaterialAsset'>(1);
    const scene = createBossScene(world, {
      body: material,
      accent: material,
      mouth: material,
      groundWarning: material,
      strike: material,
    });
    expect(world.get(scene.mouthJoint, ChildOf).unwrap().parent).toBe(scene.player);
    expect((await scenePlugin().build(world)).ok).toBe(true);
    world.update(1 / 60).unwrap();

    const resolver = particleSceneSpaceResolver({
      world,
      resolveJoint: (player: EntityHandle) => (player === scene.player ? scene.mouthJoint : undefined),
    });
    const resolved = resolver.resolve({
      player: scene.player,
      space: 'local',
      phase: 'extract',
      tick: 1,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('joint');
    expect(resolved.value.joint).toBe(scene.mouthJoint);
    expect(resolved.value.matrix[13]).toBeCloseTo(1.05);
    expect(world.get(scene.mouthJoint, Transform).unwrap().world[13]).toBeCloseTo(1.05);
  });
});
