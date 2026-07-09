// scene-mount-fixed-point.test.ts — AC-09 structural-equivalence fixed-point
// tests (feat-20260707-engine-world-clone-transient-for-editor-ssot,
// plan-strategy D-10 + §3.2 fixed-point argument).
//
// AC-09: mount-collapse no longer depends on serialized `Children`. After the
// M2 rewrite, a second rootsToSceneAsset on the reloaded world produces a
// mounts[] structurally equivalent to the first collect's mounts[] — source
// GUID / memberCount / parent per-mount equal, owned-entity set cardinality
// equal, NO Children key, and NO carrier-ghost accumulation across cycles.
//
// The scene shape here is the editor spawnGlbSceneAsMount on-disk form: an
// OWNED wrapper entity W plus a mount whose `parent` is W (NOT the synthetic
// root). This is the exact shape that exercises the D-8 deferred-wiring hole:
// on reload the mount carrier must re-acquire its ChildOf-to-W edge, or collect
// cannot reach the anchor and mounts come back undefined.
//
// D-10 semantics: structural equivalence, NOT per-position Children order. The
// first save->reload cycle may normalize order once; from the second collect
// onward the output is a strict fixed-point (collect3 === collect2).
//
// RED pre-fix (falsification anchor, strategy §5.4 third pillar): before
// m2t4/m2t5, collect2.mounts is undefined (anchor unreachable) so the
// equivalence and three-cycle assertions fail. GREEN after the fix.

import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import '../components';
import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
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
/**
 * Collect from the top-level OWNED roots (SceneInstanceState.rootEntities), not
 * the synthetic root — mirrors the editor's entRootHandles set, which excludes
 * the synthetic root and mount carriers. Collecting from the synthetic root
 * would fold the synthetic root itself in as an extra owned entity.
 */
function ownedRoots(w: World, syntheticRoot: import('@forgeax/engine-ecs').EntityHandle): number[] {
  const si = w.getSceneInstanceState(syntheticRoot);
  if (!si.ok) throw new Error('no SceneInstance state on synthetic root');
  return si.value.rootEntities.map((e) => e as unknown as number);
}

/**
 * D-10 structural equivalence of two SceneAssets: mounts (source, memberCount,
 * parent — memberFirst is derived from the owned-set cardinality and re-derived
 * each collect, so it is NOT part of the equivalence contract) + owned entity
 * set cardinality + per-entity component-type key set. Does NOT assert Children
 * per-position order (mirror is derived from spawn order).
 */
function structurallyEquivalent(a: SceneAsset, b: SceneAsset): boolean {
  const am = a.mounts ?? [];
  const bm = b.mounts ?? [];
  if (am.length !== bm.length) return false;
  // Compare mounts as a multiset keyed by (source, memberCount, parent) so a
  // one-time order normalization does not fail equivalence.
  const key = (m: (typeof am)[number]): string =>
    `${String(m.source)}|${m.memberCount}|${String(m.parent)}`;
  const aKeys = am.map(key).sort();
  const bKeys = bm.map(key).sort();
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;

  if (a.entities.length !== b.entities.length) return false;
  const compKeySet = (s: SceneAsset): string[] =>
    s.entities
      .map((e) =>
        Object.keys(e.components as Record<string, unknown>)
          .sort()
          .join(','),
      )
      .sort();
  const aC = compKeySet(a);
  const bC = compKeySet(b);
  for (let i = 0; i < aC.length; i++) if (aC[i] !== bC[i]) return false;
  return true;
}

/** No entity in the SceneAsset carries a Children component (AC-04 holds through round-trip). */
function noChildrenKey(s: SceneAsset): boolean {
  for (const e of s.entities) {
    if ((e.components as Record<string, unknown>).Children !== undefined) return false;
  }
  return true;
}

describe('AC-09 mount-collapse fixed-point (structural equivalence, D-10)', () => {
  it('owned-parent mount: collect1 ~ collect2, three cycles no ghost, Children absent', () => {
    const reg = mkReg();
    const w = new World();

    // Child scene = one owned mesh entity.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [3, 0, 0] } } }],
    };
    cat(reg, G_CHILD, child);

    // Top scene: owned wrapper W (localId 0) + mount whose parent is W. Exact
    // spawnGlbSceneAsMount on-disk shape (an owned wrapper with a nested mount).
    const top: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [1, 0, 0] } } }],
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
    cat(reg, G_TOP, top);

    const parse = accessParse(reg);

    // Cycle 1: instantiate the authored top, then collect.
    const i0 = reg.instantiate(rs(w, top), w);
    expect(i0.ok).toBe(true);
    if (!i0.ok) return;
    const c1 = rootsToSceneAsset(reg, w, ownedRoots(w, i0.value) as never);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;

    // First collect must produce exactly one mount to the child GUID, parented
    // to the owned wrapper (localId 0), and one owned wrapper entity.
    expect(c1.value.mounts?.length).toBe(1);
    expect(c1.value.mounts?.[0]?.source).toBe(G_CHILD);
    expect(c1.value.mounts?.[0]?.memberCount).toBe(1);
    expect(c1.value.mounts?.[0]?.parent).toBe(0);
    expect(c1.value.entities.length).toBe(1);
    expect(noChildrenKey(c1.value)).toBe(true);

    // Cycle 2: serialize -> parse -> catalog -> reload -> collect.
    const s1 = serializeSceneAssetToPack(c1.value, G_TOP);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const u1 = unpack(s1.value);
    const p1 = parse(u1.payload, u1.refs);
    cat(reg, G_TOP, p1);
    const i1 = reg.instantiate(rs(w, p1), w);
    expect(i1.ok).toBe(true);
    if (!i1.ok) return;
    const c2 = rootsToSceneAsset(reg, w, ownedRoots(w, i1.value) as never);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;

    // AC-09: collect2 is structurally equivalent to collect1 (source/memberCount
    // /parent per-mount, owned-set cardinality). This is the core assertion —
    // RED pre-fix because collect2.mounts comes back undefined.
    expect(structurallyEquivalent(c1.value, c2.value)).toBe(true);
    expect(noChildrenKey(c2.value)).toBe(true);

    // Cycle 3: reload once more and collect — the ghost-accretion point. From
    // the second collect onward the output is a strict fixed-point (D-10).
    const s2 = serializeSceneAssetToPack(c2.value, G_TOP);
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    const u2 = unpack(s2.value);
    const p2 = parse(u2.payload, u2.refs);
    cat(reg, G_TOP, p2);
    const i2 = reg.instantiate(rs(w, p2), w);
    expect(i2.ok).toBe(true);
    if (!i2.ok) return;
    const c3 = rootsToSceneAsset(reg, w, ownedRoots(w, i2.value) as never);
    expect(c3.ok).toBe(true);
    if (!c3.ok) return;

    // No carrier ghost accumulation: owned + mount counts are a fixed point.
    expect(c3.value.entities.length).toBe(c2.value.entities.length);
    expect((c3.value.mounts ?? []).length).toBe((c2.value.mounts ?? []).length);
    expect(structurallyEquivalent(c2.value, c3.value)).toBe(true);
    expect(noChildrenKey(c3.value)).toBe(true);
  });

  it('degenerate no-mount scene round-trips with zero regression', () => {
    const reg = mkReg();
    const w = new World();

    // Flat scene: two owned entities, no mounts.
    const flat: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { pos: [1, 0, 0] } } },
        { localId: 1 as never, components: { Transform: { pos: [2, 0, 0] } } },
      ],
    };
    cat(reg, G_TOP, flat);

    const parse = accessParse(reg);

    const i0 = reg.instantiate(rs(w, flat), w);
    expect(i0.ok).toBe(true);
    if (!i0.ok) return;
    const c1 = rootsToSceneAsset(reg, w, ownedRoots(w, i0.value) as never);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect((c1.value.mounts ?? []).length).toBe(0);
    expect(c1.value.entities.length).toBe(2);

    const s1 = serializeSceneAssetToPack(c1.value, G_TOP);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const u1 = unpack(s1.value);
    const p1 = parse(u1.payload, u1.refs);
    cat(reg, G_TOP, p1);
    const i1 = reg.instantiate(rs(w, p1), w);
    expect(i1.ok).toBe(true);
    if (!i1.ok) return;
    const c2 = rootsToSceneAsset(reg, w, ownedRoots(w, i1.value) as never);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;

    // No extra entities appear; no mounts materialize; Children absent.
    expect(c2.value.entities.length).toBe(2);
    expect((c2.value.mounts ?? []).length).toBe(0);
    expect(structurallyEquivalent(c1.value, c2.value)).toBe(true);
    expect(noChildrenKey(c2.value)).toBe(true);
  });
});
