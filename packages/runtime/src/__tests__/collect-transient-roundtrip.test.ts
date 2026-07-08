// feat-20260707-engine-world-clone-transient-for-editor-ssot M1 / m1t4:
// AC-05 roundtrip regression test (red-first — falsification anchor).
//
// TDD red phase: on un-fixed code, collect writes Children from archetype
// columns (the double-write bug). After m1t6 (Children = transient, skipped
// by collect), mirror hook becomes the sole reconstruction path => no duplicates.
//
// Assertions:
//   (a) Children.entities has zero duplicate handles after round-trip.
//   (b) Each child's ChildOf.parent points back (bijective check).
//   (c) Degenerate: zero parent-child scene round-trips correctly.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { LocalEntityId, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import '../components/scene-instance';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
function registerSceneAsset(world: World, asset: SceneAsset): any {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('m1t4 — AC-05 roundtrip regression (red-first)', () => {
  it('(a,b) roundtrip: Children.entities no duplicate + ChildOf bijectivity', () => {
    // Build hierarchy via instantiateScene's own entity structure.
    // A scene with 3 entities: e0 is root, e1 and e2 are children under e0.
    // After instantiateScene, the synthetic root has Children populated by mirror hook.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: {} },
        { localId: localId(1), components: {} },
        { localId: localId(2), components: {} },
      ],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Collect from the instantiated scene.
    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Round-trip to a fresh world.
    const world2 = new World();
    const reg2 = makeRegistry();
    const sg2 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    if (sg2.ok) reg2.catalog(sg2.value, collected.value);
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
    const h2 = world2.allocSharedRef('SceneAsset', collected.value) as any;
    const inst2 = world2.instantiateScene(h2);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Traverse the round-tripped world and check dedup + bijectivity.
    const checked = new Set<number>();

    function check(entity: EntityHandle): void {
      const raw = entity as unknown as number;
      if (checked.has(raw)) return;
      checked.add(raw);

      const kidsRes = world2.get(entity, Children);
      if (kidsRes.ok && kidsRes.value.entities.length > 0) {
        const kids = [...kidsRes.value.entities];

        // Assertion (a): no duplicate handles.
        const seen = new Set<number>();
        for (const k of kids) {
          const kidRaw = k as unknown as number;
          if (seen.has(kidRaw)) {
            // TDD red phase: this is the double-write failure.
            expect.fail(`duplicate child handle ${kidRaw}`);
          }
          seen.add(kidRaw);

          // Assertion (b): bijectivity.
          const coRes = world2.get(k as unknown as EntityHandle, ChildOf);
          if (coRes.ok) {
            expect(coRes.value.parent).toBe(entity);
          }

          check(k as unknown as EntityHandle);
        }
      }
    }

    check(inst2.value.root);
  });

  it('(c) degenerate: zero parent-child scene round-trips', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: {} }],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Round-trip through a second world.
    const world2 = new World();
    const reg2 = makeRegistry();
    const sg2 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    if (sg2.ok) reg2.catalog(sg2.value, collected.value);
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
    const h2 = world2.allocSharedRef('SceneAsset', collected.value) as any;
    const inst2 = world2.instantiateScene(h2);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Second collect also works.
    const collected2 = rootsToSceneAsset(reg2, world2, [inst2.value.root]);
    expect(collected2.ok).toBe(true);
  });
});
