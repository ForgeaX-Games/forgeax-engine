// instantiate-mount-deferred-wiring.test.ts — D-8 red-first test for the
// pre-existing structural hole that mount-collapse's serialized-Children
// dependency was masking (feat-20260707-engine-world-clone-transient-for-
// editor-ssot, plan-strategy D-8 / §3 static chain).
//
// The hole: _instantiateSceneAsset expands mounts[] FIRST (world.ts:3672-3676)
// and spawns owned entities SECOND (world.ts:3768-3790). When a mount has
// `mount.parent` pointing at an OWNED entity slot, that slot is still
// ENTITY_NULL_RAW at mount-processing time, so the ChildOf wiring guard
// (world.ts:3740-3757) silently skips — and there is NO later pass that
// re-attempts the wire. The mount carrier is therefore left WITHOUT a ChildOf
// edge to its owned parent.
//
// Before M1, the serialized `Children` array on the owned parent was written
// back on reload and re-established the W -> carrier down-link (world.ts:
// 3975-3987 array-of-entity remap), so collect's BFS could still reach the
// anchor. M1 declared `Children` transient (no longer serialized), unmasking
// the missing edge. This test asserts the edge directly, independent of
// serialized Children — so it FAILS on main too (proving the hole is
// PRE-EXISTING, not introduced by M1). m2t4's deferred wiring turns it green.

import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../asset-registry';
import { AssetRegistry } from '../asset-registry';
import { ChildOf } from '../components/child-of';
import { SceneInstance } from '../components/scene-instance';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const G_CHILD = '11111111-1111-4111-8111-111111111111';
const G_PARENT = '22222222-2222-4222-8222-222222222222';

function mkReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}
function pg(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`bad GUID: ${s}`);
  return r.value;
}
function cat(reg: AssetRegistry, g: string, p: SceneAsset): void {
  reg.catalog(pg(g), p as Asset);
}
function rs(w: World, a: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return w.allocSharedRef('SceneAsset', a);
}

describe('instantiate deferred ChildOf wiring for owned-parent mounts (D-8)', () => {
  it('mount carrier whose parent is an owned entity gets ChildOf to that owned entity', () => {
    const reg = mkReg();
    const w = new World();

    // Child scene = one owned entity.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 7 } } }],
    };
    cat(reg, G_CHILD, child);

    // Parent scene: one OWNED entity W (localId 0) + one mount whose parent
    // points at W's slot (localId 0). This is the editor's
    // spawnGlbSceneAsMount on-disk shape (wrapper W + nested mount).
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G_CHILD,
          memberFirst: 2 as never,
          memberCount: 1,
          parent: 0 as never,
        },
      ],
    };
    cat(reg, G_PARENT, parent);

    const inst = reg.instantiate(rs(w, parent), w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // The synthetic root carries SceneInstance; mapping[localId] -> live Entity.
    const si = w.get(inst.value, SceneInstance);
    expect(si.ok).toBe(true);
    if (!si.ok) return;
    const mapping = si.value.mapping;

    const ownedW = mapping[0] as unknown as number; // owned entity W (localId 0)
    const carrier = mapping[1] as unknown as EntityHandle; // mount carrier (localId 1)
    expect(ownedW).toBeDefined();
    expect(carrier).toBeDefined();

    // The carrier MUST have a ChildOf whose parent is the owned entity W.
    const co = w.get(carrier, ChildOf);
    expect(co.ok, 'mount carrier must carry a ChildOf component').toBe(true);
    if (!co.ok) return;
    expect(
      (co.value as { parent: number }).parent,
      'carrier ChildOf.parent must equal the owned parent entity W',
    ).toBe(ownedW);
  });
});
