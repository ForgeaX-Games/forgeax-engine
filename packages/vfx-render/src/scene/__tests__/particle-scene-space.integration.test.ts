import { type EntityHandle, encodeEntity, World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { particleSceneSpaceResolver } from '../particle-scene-space.js';

function translation(entity: EntityHandle, world: World, x: number): void {
  world.get(entity, Transform).unwrap().world[12] = x;
}

describe('particle scene space resolver', () => {
  it('reads root and live parent world poses for local extraction', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: root } })
      .unwrap();
    translation(root, world, 4);
    translation(child, world, 7);

    const resolver = particleSceneSpaceResolver({ world });
    const resolved = resolver.resolve({
      player: child,
      space: 'local',
      phase: 'extract',
      tick: 3,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('parent');
    expect(resolved.value.parent).toBe(root);
    expect(resolved.value.matrix[12]).toBe(4);
  });

  it('reports an unavailable stale parent and can retry after repair', () => {
    const world = new World();
    const staleParent = encodeEntity(999, 0);
    const child = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: staleParent } },
      )
      .unwrap();
    const resolver = particleSceneSpaceResolver({ world });

    const unavailable = resolver.resolve({
      player: child,
      space: 'world',
      phase: 'spawn',
      tick: 4,
    });
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) return;
    expect(unavailable.error.code).toBe('particle-space-parent-unavailable');
    expect(unavailable.error.detail.parent).toBe(staleParent);

    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    world.addComponent(child, { component: ChildOf, data: { parent: root } });
    const repaired = resolver.resolve({
      player: child,
      space: 'world',
      phase: 'spawn',
      tick: 5,
    });
    expect(repaired.ok).toBe(true);
  });
});
