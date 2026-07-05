// collect-scene-mount-collapse.test.ts — M2 mount-collapse tests
// (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).

import { type EntityHandle, err, ok, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../asset-registry';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import { SceneInstance } from '../components/scene-instance';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function mkReg() {
  return new AssetRegistry(makeMockShaderRegistry());
}
function pg(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`bad GUID`);
  return r.value;
}
function soi(reg: AssetRegistry, p: SceneAsset, g: string) {
  (reg as unknown as { _originIndex: WeakMap<SceneAsset, string> })._originIndex.set(p, g);
}
function rs(w: World, a: SceneAsset) {
  return w.allocSharedRef('SceneAsset', a);
}
function wr(w: World, ph: Handle<'SceneAsset', 'shared'>, ch: Handle<'SceneAsset', 'shared'>) {
  w._setSceneAssetResolver?.((_s, pH) =>
    (pH as unknown as number) === (ph as unknown as number)
      ? ok(ch)
      : err({ code: 'asset-not-found' }),
  );
}
function rcoAll(reg: AssetRegistry, w: World, root: EntityHandle) {
  for (const e of w.iterDescendants(root)) {
    if (!w.get(e, SceneInstance).ok) continue;
    const s = w.getSceneAssetForInstance(e);
    if (!s.ok) continue;
    const c = resolveAssetHandle<SceneAsset>(w, s.value as unknown as Handle<string, 'shared'>);
    if (!c.ok) continue;
    soi(reg, c.value as SceneAsset, G1);
    soi(reg, c.value as SceneAsset, G2);
  }
}

const G1 = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const G2 = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';

// ── m2-t1: Form 2 — root itself is SceneInstance ──
describe('m2-t1 — Form 2: root itself is SceneInstance', () => {
  it('whole tree collapses: root stripped, child mount excludes members', () => {
    const reg = mkReg();
    const w = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    reg.catalog(pg(G1), child as Asset);

    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [{ localId: 1 as never, source: 0, memberFirst: 2 as never, memberCount: 1 }],
    };
    const ch = rs(w, child);
    const ph = rs(w, parent);
    wr(w, ph, ch);

    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Root is SceneInstance → root's own entities are owned.
    // Child's member entities are excluded.
    const s = res.value;
    expect(s.entities.length).toBeGreaterThanOrEqual(1); // parent's own entity
    for (const e of s.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
    // Child anchor produces a mount.
    expect(s.mounts).toBeDefined();
    expect(s.mounts?.length).toBe(1);
    expect(s.mounts?.[0]?.source).toBe(G1);
  });
});

// ── m2-t2: Form 1 — deep anchor ──
describe('m2-t2 — Form 1: deep anchor with ChildOf parent', () => {
  it('anchor subtree collapses, ancestors preserved as owned', () => {
    const reg = mkReg();
    const w = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { posX: 1 } } },
        { localId: 1 as never, components: { Transform: { posX: 2 } } },
      ],
    };
    reg.catalog(pg(G1), child as Asset);
    const ch = rs(w, child);

    const outerRes = w.spawn({ component: ChildOf, data: { parent: 0 as EntityHandle } });
    expect(outerRes.ok).toBe(true);
    if (!outerRes.ok) return;
    const outerE = outerRes.value;

    const ci = w.instantiateScene(ch, outerE);
    expect(ci.ok).toBe(true);
    if (!ci.ok) return;
    rcoAll(reg, w, ci.value.root);

    // Wire Children on outer root so collectSubtree discovers anchor.
    const ec = w.get(outerE, Children as never);
    if (!ec.ok)
      w.addComponent(outerE, { component: Children, data: { entities: [ci.value.root] } } as never);

    const res = rootsToSceneAsset(reg, w, [outerE]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Outer root is NOT SceneInstance → no mount for it.
    // Child anchor produces a mount; its member entities excluded from owned.
    expect(res.value.mounts).toBeDefined();
    expect(res.value.mounts?.length).toBe(1);
    expect(res.value.mounts?.[0]?.source).toBe(G1);
    for (const e of res.value.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
  });
});

// ── m2-t3: AC-03 window invariants ──
describe('m2-t3 — AC-03 window invariants', () => {
  it('mount window covers full totalSlots', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [{ localId: 1 as never, source: 0, memberFirst: 2 as never, memberCount: 1 }],
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mounts?.[0]?.memberCount).toBe(1);
  });

  it('sparse localId does not shrink window', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { posX: 1 } } },
        { localId: 1 as never, components: { Transform: { posX: 2 } } },
      ],
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [{ localId: 1 as never, source: 0, memberFirst: 2 as never, memberCount: 2 }],
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    // Despawn one member to create sparse mapping.
    // Member slots start at memberFirst=2 (mount entity is at mapping[1]).
    // Despawning the mount entity would cascade-kill the child synthetic root
    // (ChildOf.linkedSpawn=true), erasing the anchor entirely.
    const si = w.get(inst.value.root, SceneInstance);
    if (si.ok && si.value.mapping[2] !== undefined) w.despawn(si.value.mapping[2] as EntityHandle);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mounts?.[0]?.memberCount).toBe(2); // totalSlots, not live count
  });

  it('multiple child mounts have non-overlapping windows', () => {
    const reg = mkReg();
    const w = new World();
    const cA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    const cB: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: {} } },
        { localId: 1 as never, components: { Transform: {} } },
      ],
    };
    reg.catalog(pg(G1), cA as Asset);
    reg.catalog(pg(G2), cB as Asset);
    const hA = rs(w, cA);
    const hB = rs(w, cB);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [
        { localId: 1 as never, source: 0, memberFirst: 3 as never, memberCount: 1 },
        { localId: 2 as never, source: 1, memberFirst: 4 as never, memberCount: 2 },
      ],
    };
    const ph = rs(w, pa);
    w._setSceneAssetResolver?.((sIdx, pH) =>
      (pH as unknown as number) !== (ph as unknown as number)
        ? err({ code: 'asset-not-found' })
        : sIdx === 0
          ? ok(hA)
          : ok(hB),
    );

    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    for (const e of w.iterDescendants(inst.value.root)) {
      if (!w.get(e, SceneInstance).ok) continue;
      const s = w.getSceneAssetForInstance(e);
      if (!s.ok) continue;
      const c = resolveAssetHandle<SceneAsset>(w, s.value as unknown as Handle<string, 'shared'>);
      if (!c.ok) continue;
      soi(reg, c.value as SceneAsset, c.value.entities.length === 1 ? G1 : G2);
    }

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const ms = res.value.mounts ?? [];
    expect(ms.length).toBe(2);
    const W = ms
      .map((m) => ({ f: m.memberFirst as number, c: m.memberCount }))
      .sort((a, b) => a.f - b.f);
    for (let i = 0; i < W.length - 1; i++) {
      const cur = W[i];
      const next = W[i + 1];
      if (!cur || !next) throw new Error('window index out of range');
      expect(cur.f + cur.c).toBeLessThanOrEqual(next.f);
    }
    const owned = new Set(res.value.entities.map((e) => e.localId as unknown as number));
    for (const w of W)
      for (let lid = w.f; lid < w.f + w.c; lid++) expect(owned.has(lid)).toBe(false);
  });
});

// ── m2-t4: Graft preservation ──
describe('m2-t4 — graft preservation', () => {
  it('graft entity under a member survives as owned', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [{ localId: 1 as never, source: 0, memberFirst: 2 as never, memberCount: 1 }],
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value.root;
    rcoAll(reg, w, root);

    const si = w.get(root, SceneInstance);
    if (!si.ok) return;
    const member = si.value.mapping[0];
    if (member === undefined) return;

    // Graft a prop entity under the member.
    const prop = w.spawn({ component: ChildOf, data: { parent: member as EntityHandle } });
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    w.addComponent(
      member as EntityHandle,
      { component: Children, data: { entities: [prop.value] } } as never,
    );

    const res = rootsToSceneAsset(reg, w, [root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Prop should survive as owned entity (not eaten by mount).
    let propFound = false;
    for (const e of res.value.entities) {
      if ((e.components as Record<string, Record<string, unknown>>).ChildOf) {
        propFound = true;
        break;
      }
    }
    expect(propFound).toBe(true);
  });

  it('unmappable cross-window entity ref fails fast', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [{ localId: 1 as never, source: 0, memberFirst: 2 as never, memberCount: 1 }],
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = w.instantiateScene(ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value.root;
    rcoAll(reg, w, root);

    const si = w.get(root, SceneInstance);
    if (!si.ok) return;
    const member = si.value.mapping[0];
    if (member === undefined) return;

    // Graft with ChildOf.parent pointing outside closure.
    // Spawn `outside` without ChildOf — no parent linkage, so it stays
    // unreachable from the root subtree and _rlid(graft.parent) fails.
    const outside = w.spawn();
    expect(outside.ok).toBe(true);
    if (!outside.ok) return;

    const graft = w.spawn({ component: ChildOf, data: { parent: outside.value } });
    expect(graft.ok).toBe(true);
    if (!graft.ok) return;
    w.addComponent(
      member as EntityHandle,
      { component: Children, data: { entities: [graft.value] } } as never,
    );

    const res = rootsToSceneAsset(reg, w, [root]);
    expect(res.ok).toBe(false); // fail-fast
  });
});
