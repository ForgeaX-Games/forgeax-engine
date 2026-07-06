// scene-mount-wrapper-roundtrip.test.ts — regression for the editor "Add to
// Scene" ghost-node accretion bug.
//
// The editor's whole-GLB Add-to-Scene (spawnGlbSceneAsMount) produces a scene
// pack shaped like:
//     entities: [ ..., { localId: W, Name:"bed.glb", Transform, Children:[M] } ]
//     mounts:   [ { localId: M, source: <bedGUID>, memberCount: N, parent: W } ]
// i.e. an OWNED wrapper entity whose child is a nested mount. This is the exact
// on-disk shape after the first add+save.
//
// On RELOAD, world.instantiateScene re-materialises the mount as a plain "mount
// entity" (no Name, no SceneInstance — just Transform/ChildOf/Children) sitting
// BETWEEN the wrapper and the child SceneInstance root. On the NEXT collect that
// plain mount entity carries no SceneInstance, so rootsToSceneAsset emitted it
// as an OWNED (nameless) entity + a fresh mount — one extra ghost node per
// save→reload cycle. This test asserts collect is a FIXED POINT across two
// reload cycles.

import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../asset-registry';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { Children, Name, Transform } from '../components';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const G_CHILD = '11111111-1111-4111-8111-111111111111';
const G_TOP = '22222222-2222-4222-8222-222222222222';

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
function accessParse(reg: AssetRegistry) {
  const internal = reg as unknown as {
    parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
  };
  return (payload: Record<string, unknown>, refs?: readonly string[]): SceneAsset =>
    internal.parseAssetPayload('scene', payload, refs as string[] | undefined) as SceneAsset;
}
function unpack(pack: Record<string, unknown>): {
  payload: Record<string, unknown>;
  refs: readonly string[] | undefined;
} {
  const a = (pack.assets as Record<string, unknown>[])[0] as Record<string, unknown>;
  return { payload: a.payload as Record<string, unknown>, refs: a.refs as string[] | undefined };
}

describe('editor Add-to-Scene wrapper+mount round-trip (ghost accretion regression)', () => {
  it('collect is a fixed point across reload cycles (no nameless ghost accretes)', () => {
    const reg = mkReg();
    const w = new World();

    // Child scene = the "bed": one owned mesh entity.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: { Name: { value: 'bed-mesh' }, Transform: { posX: 0 } },
        },
      ],
    };
    cat(reg, G_CHILD, child);

    // Plain top scene with ONE owned entity (like spin-cube's Ground). The
    // editor adds the mount live below via a wrapper (no mounts[] on disk yet).
    const top: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Name: { value: 'Ground' }, Transform: { posX: 0 } } },
      ],
    };
    cat(reg, G_TOP, top);

    const parse = accessParse(reg);

    const runCycle = (roots: number[]): { owned: number; mounts: number; pack: SceneAsset } => {
      const c = rootsToSceneAsset(reg, w, roots as never);
      if (!c.ok) throw new Error(`collect failed: ${JSON.stringify(c.error)}`);
      return {
        owned: c.value.entities.length,
        mounts: (c.value.mounts ?? []).length,
        pack: c.value,
      };
    };

    // The editor's owned top-level roots after a reload = the named entities the
    // session tracks (store.ts _e2h owned-set: the scene asset's entities[], not
    // mount internals). Mirror that here by taking the NAMED entities reachable
    // from the scene (Ground + the bed.glb wrapper), excluding the nameless
    // mount carrier — exactly what the editor collects via entRootHandles.
    const namedTopEntities = (syntheticRoot: number): number[] => {
      const wr = w as unknown as {
        get(
          e: number,
          c: unknown,
        ): {
          ok: boolean;
          value?: { entities?: ArrayLike<number>; value?: string; parent?: number };
        };
      };
      // BFS from the synthetic root over Children; keep NAMED entities whose
      // parent is not itself a named-tracked entity (i.e. top-level owned roots).
      const named: number[] = [];
      const queue = [syntheticRoot];
      const seen = new Set<number>([syntheticRoot]);
      while (queue.length) {
        const cur = queue.shift() as number;
        const ch = wr.get(cur, Children);
        if (ch.ok && ch.value?.entities) {
          for (const k of Array.from(ch.value.entities)) {
            if (seen.has(k)) continue;
            seen.add(k);
            queue.push(k);
            if (wr.get(k, Name).ok) named.push(k);
          }
        }
      }
      return named;
    };

    // Instantiate the top scene.
    const i0 = reg.instantiate(rs(w, top), w);
    expect(i0.ok).toBe(true);
    if (!i0.ok) return;

    // ── Editor "Add to Scene": spawn a NAMED wrapper parented under the top
    //    scene, then mount the child scene UNDER the wrapper (instantiate with
    //    parent=wrapper). Mirrors spawnGlbSceneAsMount +
    //    instantiateSceneRefUnderWorld. ──
    const wrapperRes = w.spawn(
      { component: Name, data: { value: 'bed.glb' } },
      { component: Transform, data: { posX: 0 } },
    );
    expect(wrapperRes.ok).toBe(true);
    if (!wrapperRes.ok) return;
    const mountRes = reg.instantiate(rs(w, child), w, wrapperRes.value);
    expect(mountRes.ok).toBe(true);
    if (!mountRes.ok) return;

    // Cycle 1: collect from the owned roots (Ground + wrapper).
    // Ground is a child of the synthetic root; the wrapper is a free root we
    // just spawned. Collect from both (the editor's entRootHandles set).
    const groundRoots = namedTopEntities(i0.value as unknown as number);
    const c1 = runCycle([...groundRoots, wrapperRes.value as unknown as number]);

    // Cycle 2: serialize → parse → reload → collect.
    const s1 = serializeSceneAssetToPack(c1.pack, G_TOP);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const u1 = unpack(s1.value);
    const p1 = parse(u1.payload, u1.refs);
    cat(reg, G_TOP, p1);
    const i1 = reg.instantiate(rs(w, p1), w);
    expect(i1.ok).toBe(true);
    if (!i1.ok) return;
    const c2 = runCycle(namedTopEntities(i1.value as unknown as number));

    // Cycle 3: reload + collect once more (the ghost-accretion point).
    const s2 = serializeSceneAssetToPack(c2.pack, G_TOP);
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    const u2 = unpack(s2.value);
    const p2 = parse(u2.payload, u2.refs);
    cat(reg, G_TOP, p2);
    const i2 = reg.instantiate(rs(w, p2), w);
    expect(i2.ok).toBe(true);
    if (!i2.ok) return;
    const c3 = runCycle(namedTopEntities(i2.value as unknown as number));

    // ACCEPTANCE: owned + mount counts are a FIXED POINT across reloads (before
    // the fix this grew unboundedly: owned 2 → 3 → 5, one nameless ghost per
    // cycle). Ground + bed.glb wrapper = 2 owned; the bed = 1 mount.
    expect({ owned: c1.owned, mounts: c1.mounts }).toEqual({ owned: 2, mounts: 1 });
    expect({ owned: c2.owned, mounts: c2.mounts }).toEqual({ owned: 2, mounts: 1 });
    expect({ owned: c3.owned, mounts: c3.mounts }).toEqual({ owned: 2, mounts: 1 });

    // No owned entity is nameless (the ghost signature).
    for (const e of c3.pack.entities) {
      const comps = e.components as Record<string, Record<string, unknown>>;
      expect(comps.Name, `owned entity localId ${e.localId} must have a Name`).toBeDefined();
    }
  });
});
