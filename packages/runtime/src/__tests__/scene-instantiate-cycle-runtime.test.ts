// feat-20260608-scene-nesting-ecs-fication M2 / w21 (red phase) — runtime
// cycle fail-fast (AC-13). Constructs a hand-authored SceneAsset graph
// A -> B -> C -> A via mount.source resolved through a test-only
// SceneAssetResolver, bypassing the build-time scanner. World's recursive
// _instantiateSceneRec is expected to detect the cycle via its private
// stack (Set<Guid>) and fail-fast pack-cyclic-reference + detail.kind:
// 'mount-asset' + detail.cycle: GUID[] (plan-strategy §D-3).

import { err, ok, World } from '@forgeax/engine-ecs';
// Side-effect import: register Transform / ChildOf etc. via the runtime
// component barrel so the implementation's resolveComponent('ChildOf') call
// in _spawnMountEntity sees a defined token.
import '@forgeax/engine-runtime';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('runtime cycle fail-fast (w21)', () => {
  it('A -> B -> C -> A surfaces pack-cyclic-reference / mount-asset', () => {
    const world = new World();
    // Build mount entries that name source=0 (parent's refs[0]) — the
    // resolver maps each parent handle to a different child handle so the
    // 3-asset chain forms A -> B -> C -> A.
    const assetA: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: 0, memberFirst: 1 as never, memberCount: 0 }],
    };
    const assetB: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: 0, memberFirst: 1 as never, memberCount: 0 }],
    };
    const assetC: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: 0, memberFirst: 1 as never, memberCount: 0 }],
    };
    const handleA = registerSceneAsset(world, assetA);
    const handleB = registerSceneAsset(world, assetB);
    const handleC = registerSceneAsset(world, assetC);
    world._setSceneAssetResolver?.((sourceIdx, parentHandle) => {
      void sourceIdx;
      const raw = parentHandle as unknown as number;
      if (raw === (handleA as unknown as number)) return ok(handleB);
      if (raw === (handleB as unknown as number)) return ok(handleC);
      if (raw === (handleC as unknown as number)) return ok(handleA);
      return err({ code: 'asset-not-found' });
    });
    const r = world.instantiateScene(handleA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.error as { code: string; detail?: { kind?: string; cycle?: readonly string[] } };
    expect(e.code).toBe('pack-cyclic-reference');
    expect(e.detail?.kind).toBe('mount-asset');
    expect(Array.isArray(e.detail?.cycle)).toBe(true);
    expect((e.detail?.cycle ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
