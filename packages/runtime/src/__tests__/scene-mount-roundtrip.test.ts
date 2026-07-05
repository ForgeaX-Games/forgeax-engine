// scene-mount-roundtrip.test.ts — M4 round-trip acceptance tests
// (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).
//
// Coverage:
//   m4-t1: single-layer mount round-trip (collect -> serialize -> reload -> collect)
//   m4-t2: double-layer nested mount round-trip
//   m4-t3: fixed-point — post-normalization second collect equals third collect
//
// These tests exercise the full AC-04 chain:
//   instantiate -> rootsToSceneAsset -> serializeSceneAssetToPack ->
//   parse back -> catalog -> registry.instantiate (reload) ->
//   rootsToSceneAsset -> structural equivalence

import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../asset-registry';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { SceneInstance } from '../components/scene-instance';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

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

/** Access parseAssetPayload via type assertion (same pattern as M3 tests). */
function accessParseScenePayload(reg: AssetRegistry) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = reg as unknown as {
    parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
  };
  return (
    kind: string,
    payload: Record<string, unknown>,
    refs?: readonly string[] | undefined,
  ): SceneAsset | undefined => {
    const result = internal.parseAssetPayload(kind, payload, refs as string[] | undefined);
    if (result === undefined) return undefined;
    if (
      typeof result === 'object' &&
      result !== null &&
      'kind' in result &&
      (result as { kind: string }).kind === 'scene'
    ) {
      return result as SceneAsset;
    }
    return undefined;
  };
}

/** Extract payload and refs from serializeSceneAssetToPack result. */
function unpackSerialized(
  pack: Record<string, unknown>,
): { payload: Record<string, unknown>; refs: readonly string[] | undefined } | undefined {
  const assets = pack.assets as readonly Record<string, unknown>[] | undefined;
  if (!assets || assets.length === 0) return undefined;
  const a = assets[0];
  if (!a) return undefined;
  const payload = a.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  return { payload, refs: a.refs as readonly string[] | undefined };
}

/**
 * Deep-structural comparison of two SceneAsset objects.
 * Returns true if mounts (source, memberFirst, memberCount, parent) and
 * entities (component types, field values) are structurally equivalent.
 * localId values are compared as-is (they should be stable across collects).
 */
function scenesAreStructurallyEquivalent(a: SceneAsset, b: SceneAsset): boolean {
  const am = a.mounts ?? [];
  const bm = b.mounts ?? [];
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) {
    const ma = am[i];
    const mb = bm[i];
    if (!ma || !mb) return false;
    if (ma.source !== mb.source) return false;
    if (ma.memberFirst !== mb.memberFirst) return false;
    if (ma.memberCount !== mb.memberCount) return false;
    if (ma.parent !== mb.parent) return false;
  }

  const ae = a.entities;
  const be = b.entities;
  if (ae.length !== be.length) return false;
  for (let i = 0; i < ae.length; i++) {
    const ea = ae[i];
    const eb = be[i];
    if (!ea || !eb) return false;
    if (ea.localId !== eb.localId) return false;

    const compsA = ea.components as Record<string, Record<string, unknown>>;
    const compsB = eb.components as Record<string, Record<string, unknown>>;
    const keysA = Object.keys(compsA).sort();
    const keysB = Object.keys(compsB).sort();
    if (keysA.length !== keysB.length) return false;
    for (let j = 0; j < keysA.length; j++) {
      if (keysA[j] !== keysB[j]) return false;
    }
    for (const key of keysA) {
      const fieldsA = compsA[key];
      const fieldsB = compsB[key];
      if (!fieldsA || !fieldsB) return false;
      const fKeysA = Object.keys(fieldsA).sort();
      const fKeysB = Object.keys(fieldsB).sort();
      if (fKeysA.length !== fKeysB.length) return false;
      for (let j = 0; j < fKeysA.length; j++) {
        if (fKeysA[j] !== fKeysB[j]) return false;
        const va = fieldsA[fKeysA[j] as string];
        const vb = fieldsB[fKeysB[j] as string];
        if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
      }
    }
  }
  return true;
}

/**
 * Compute the totalSlots of a SceneAsset as _instantiateSceneAsset would:
 * countBaseline = entities.length + mounts.length + sum(mounts.memberCount).
 */
function computeTotalSlots(scene: SceneAsset): number {
  const ms = scene.mounts ?? [];
  const memberSum = ms.reduce((s, m) => s + m.memberCount, 0);
  const countBaseline = scene.entities.length + ms.length + memberSum;
  let maxLocalId = -1;
  for (const e of scene.entities) {
    maxLocalId = Math.max(maxLocalId, e.localId as unknown as number);
  }
  for (const m of ms) {
    maxLocalId = Math.max(maxLocalId, m.localId as unknown as number);
    const last = (m.memberFirst as unknown as number) + m.memberCount - 1;
    maxLocalId = Math.max(maxLocalId, last);
  }
  return Math.max(countBaseline, maxLocalId + 1);
}

const G1 = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const G2 = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const G3 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const G4 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ═══════════════════════════════════════════════════════════════════════════════
// m4-t1: single-layer mount round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('m4-t1 — single-layer mount round-trip', () => {
  it('full round-trip: collect -> serialize -> reload -> collect — mounts and GUIDs preserved', () => {
    const reg = mkReg();
    const w = new World();

    // Step 1: Build child scene.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { posX: 1 } } },
        { localId: 1 as never, components: { Transform: { posX: 2 } } },
      ],
    };
    cat(reg, G1, child);

    // Step 2: Build parent scene with mount (source = GUID string, post-parse shape).
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 2,
        },
      ],
    };
    cat(reg, G2, parent);
    const ph = rs(w, parent);

    // Step 3: Instantiate parent via registry.
    const inst = reg.instantiate(ph, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value;

    // Verify root exists and has descendants including a child SceneInstance.
    let descendantCount = 0;
    let hasChildSceneInstance = false;
    for (const c of w.iterDescendants(root)) {
      if (c === root) continue;
      descendantCount++;
      if (w.get(c, SceneInstance).ok) hasChildSceneInstance = true;
    }
    expect(descendantCount).toBeGreaterThanOrEqual(2);
    expect(hasChildSceneInstance).toBe(true);

    // Step 4: First collect (rootsToSceneAsset).
    const collect1 = rootsToSceneAsset(reg, w, [root]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    // Assert first collect: one mount, source = G1, memberCount = 2.
    expect(collect1.value.mounts).toBeDefined();
    expect(collect1.value.mounts?.length).toBe(1);
    const m0 = collect1.value.mounts?.[0];
    expect(m0).toBeDefined();
    if (!m0) return;
    expect(m0.source).toBe(G1);
    expect(m0.memberCount).toBe(2);

    // No SceneInstance component rows in owned entities.
    for (const e of collect1.value.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }

    // Step 5: Serialize (breakpoint A — mounts must survive).
    const serRes = serializeSceneAssetToPack(collect1.value, G3);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;
    const serMounts = unpacked.payload.mounts as ReadonlyArray<Record<string, unknown>> | undefined;
    expect(serMounts).toBeDefined();
    expect(serMounts?.length).toBe(1);
    // source should be refs index, not GUID string.
    expect(typeof serMounts?.[0]?.source).toBe('number');

    // Step 6: Parse back (breakpoint B — mounts must survive parse).
    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;
    expect(parsed.mounts).toBeDefined();
    expect(parsed.mounts?.length).toBe(1);
    // source should be restored to GUID string.
    expect(parsed.mounts?.[0]?.source).toBe(G1);

    // Step 7: Reload — catalog + allocSharedRef + registry.instantiate.
    cat(reg, G3, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;
    const root2 = inst2.value;

    // Verify reloaded tree has child SceneInstance.
    let hasChildSi2 = false;
    for (const c of w.iterDescendants(root2)) {
      if (c === root2) continue;
      if (w.get(c, SceneInstance).ok) {
        hasChildSi2 = true;
        break;
      }
    }
    expect(hasChildSi2).toBe(true);

    // Step 8: Re-collect from reloaded tree.
    const collect2 = rootsToSceneAsset(reg, w, [root2]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Assert reloaded collect: mounts preserved with correct source and memberCount.
    expect(collect2.value.mounts).toBeDefined();
    expect(collect2.value.mounts?.length).toBe(1);
    const m2 = collect2.value.mounts?.[0];
    expect(m2).toBeDefined();
    if (!m2) return;
    expect(m2.source).toBe(G1);
    expect(m2.memberCount).toBe(2);

    // No SceneInstance component rows in second collect.
    for (const e of collect2.value.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
  });

  it('mount source GUID and memberCount preserved across round-trip', () => {
    const reg = mkReg();
    const w = new World();

    // Child scene with one entity.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 5 } } }],
    };
    cat(reg, G1, child);

    // Parent with one entity + mount.
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    cat(reg, G2, parent);
    const ph = rs(w, parent);

    const inst = reg.instantiate(ph, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const collect1 = rootsToSceneAsset(reg, w, [inst.value]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    expect(collect1.value.mounts?.[0]?.source).toBe(G1);
    expect(collect1.value.mounts?.[0]?.memberCount).toBe(1);

    // Serialize -> parse -> catalog -> reload.
    const serRes = serializeSceneAssetToPack(collect1.value, G3);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;

    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    cat(reg, G3, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    const collect2 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Mount source GUID and memberCount must survive round-trip.
    expect(collect2.value.mounts?.length).toBe(collect1.value.mounts?.length);
    expect(collect2.value.mounts?.[0]?.source).toBe(collect1.value.mounts?.[0]?.source);
    expect(collect2.value.mounts?.[0]?.memberCount).toBe(collect1.value.mounts?.[0]?.memberCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m4-t2: double-layer nested mount round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('m4-t2 — double-layer nested mount round-trip', () => {
  it('A mount B, B mount C — round-trip preserves mount sources and ChildOf hierarchy', () => {
    const reg = mkReg();
    const w = new World();

    // Grandchild scene C.
    const sceneC: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
    };
    cat(reg, G1, sceneC);

    // Child scene B: mounts C.
    const sceneB: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    cat(reg, G2, sceneB);

    // Parent scene A: mounts B. B's totalSlots = max(1+1+1, max(0,1,2)+1) = 3.
    const bTotalSlots = computeTotalSlots(sceneB);
    expect(bTotalSlots).toBe(3);
    const sceneA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 100 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G2,
          memberFirst: 2 as never,
          memberCount: bTotalSlots,
        },
      ],
    };
    cat(reg, G3, sceneA);
    const ha = rs(w, sceneA);

    // Instantiate A via registry (exercises recursive mount resolution).
    const inst = reg.instantiate(ha, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value;

    // Verify nested structure: root should have descendants including
    // SceneInstance-carrying entities.
    let sceneInstanceCount = 0;
    for (const c of w.iterDescendants(root)) {
      if (c === root) continue;
      if (w.get(c, SceneInstance).ok) sceneInstanceCount++;
    }
    // At least 2 SceneInstance entities: B's child root and C's child root.
    expect(sceneInstanceCount).toBeGreaterThanOrEqual(2);

    // Step 1: Collect from original instantiated tree.
    const collect1 = rootsToSceneAsset(reg, w, [root]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    // Collect1: root is Form 2, B and C are both non-root anchors.
    // Each produces a mount entry in the output SceneAsset.
    expect(collect1.value.mounts).toBeDefined();
    const mountCount1 = collect1.value.mounts?.length ?? 0;
    expect(mountCount1).toBeGreaterThanOrEqual(2);

    // Both source GUIDs should be present in mounts.
    const sources1 = collect1.value.mounts?.map((m) => m.source).sort() ?? [];
    expect(sources1).toContain(G1);
    expect(sources1).toContain(G2);

    // No SceneInstance component rows in owned entities.
    for (const e of collect1.value.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }

    // Step 2: Serialize -> parse -> catalog -> reload.
    const serRes = serializeSceneAssetToPack(collect1.value, G4);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;

    // Verify serialized mounts have source as refs index.
    const serMounts = unpacked.payload.mounts as ReadonlyArray<Record<string, unknown>> | undefined;
    expect(serMounts).toBeDefined();
    expect(serMounts?.length).toBe(mountCount1);
    for (const sm of serMounts ?? []) {
      expect(typeof sm.source).toBe('number');
    }

    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    // Verify parsed mounts have source as GUID strings.
    expect(parsed.mounts?.length).toBe(mountCount1);
    for (const pm of parsed.mounts ?? []) {
      expect(typeof pm.source).toBe('string');
    }

    // Reload.
    cat(reg, G4, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Verify nested structure survives reload.
    let siCount2 = 0;
    for (const c of w.iterDescendants(inst2.value)) {
      if (c === inst2.value) continue;
      if (w.get(c, SceneInstance).ok) siCount2++;
    }
    expect(siCount2).toBeGreaterThanOrEqual(2);

    // Step 3: Re-collect from reloaded tree.
    const collect2 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Both original GUIDs should still appear in mounts.
    const sources2 = collect2.value.mounts?.map((m) => m.source).sort() ?? [];
    expect(sources2).toContain(G1);
    expect(sources2).toContain(G2);

    for (const e of collect2.value.entities) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
  });

  it('window accounting correct after double-layer round-trip', () => {
    const reg = mkReg();
    const w = new World();

    // Grandchild C: 2 entities.
    const sceneC: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { posX: 1 } } },
        { localId: 1 as never, components: { Transform: { posX: 2 } } },
      ],
    };
    cat(reg, G1, sceneC);

    // Child B: mounts C.
    const sceneB: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 2,
        },
      ],
    };
    const bSlots = computeTotalSlots(sceneB);
    cat(reg, G2, sceneB);

    // Parent A: mounts B with correct memberCount.
    const sceneA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 100 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G2,
          memberFirst: 2 as never,
          memberCount: bSlots,
        },
      ],
    };
    cat(reg, G3, sceneA);
    const ha = rs(w, sceneA);

    const inst = reg.instantiate(ha, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const collect1 = rootsToSceneAsset(reg, w, [inst.value]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    // Verify window accounting: each mount has memberCount > 0.
    const mounts1 = collect1.value.mounts ?? [];
    for (const m of mounts1) {
      expect(m.memberCount).toBeGreaterThan(0);
    }
    // Windows should not overlap.
    const windows = mounts1
      .map((m) => ({ f: m.memberFirst as number, c: m.memberCount }))
      .sort((a, b) => a.f - b.f);
    for (let i = 0; i < windows.length - 1; i++) {
      const cur = windows[i];
      const next = windows[i + 1];
      if (!cur || !next) continue;
      expect(cur.f + cur.c).toBeLessThanOrEqual(next.f);
    }

    // Serialize -> reload.
    const serRes = serializeSceneAssetToPack(collect1.value, G4);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;

    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    cat(reg, G4, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    const collect2 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Window accounting must be preserved: all mounts have memberCount > 0
    // and windows do not overlap.
    const mounts2 = collect2.value.mounts ?? [];
    for (const m of mounts2) {
      expect(m.memberCount).toBeGreaterThan(0);
    }
    const windows2 = mounts2
      .map((m) => ({ f: m.memberFirst as number, c: m.memberCount }))
      .sort((a, b) => a.f - b.f);
    for (let i = 0; i < windows2.length - 1; i++) {
      const cur = windows2[i];
      const next = windows2[i + 1];
      if (!cur || !next) continue;
      expect(cur.f + cur.c).toBeLessThanOrEqual(next.f);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m4-t3: fixed-point — post-normalization collect stability
// ═══════════════════════════════════════════════════════════════════════════════
//
// Per D-9, the first reload introduces a one-time structural normalization.
// The true fixed-point guard: after reload, successive collects from the
// same live tree produce identical results (collect2 == collect3).
//
// If collect2 keeps an entity as owned but collect3 folds it into a mount
// (or vice versa), the fixed-point is broken and D-9 is violated.

describe('m4-t3 — fixed-point: post-normalization collect equality', () => {
  it('single-layer: collect2 == collect3 from same reloaded tree (D-9 fixed-point)', () => {
    const reg = mkReg();
    const w = new World();

    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { posX: 1 } } },
        { localId: 1 as never, components: { Transform: { posX: 2 } } },
      ],
    };
    cat(reg, G1, child);

    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 2,
        },
      ],
    };
    cat(reg, G2, parent);
    const ph = rs(w, parent);

    // Collect 1 (before reload).
    const inst = reg.instantiate(ph, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const collect1 = rootsToSceneAsset(reg, w, [inst.value]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    // Serialize -> parse -> catalog -> first reload.
    const serRes = serializeSceneAssetToPack(collect1.value, G3);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;

    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    cat(reg, G3, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Collect 2 (after first reload — post-normalization).
    const collect2 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Collect 3 (from same live tree, no additional reload).
    const collect3 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect3.ok).toBe(true);
    if (!collect3.ok) return;

    // D-9 fixed-point guard: post-normalization, collect2 == collect3.
    // If this fails, the structure is not stable — something changes
    // between successive collects from the same live tree.
    expect(scenesAreStructurallyEquivalent(collect2.value, collect3.value)).toBe(true);

    // Mounts must match between collect2 and collect3.
    expect(collect3.value.mounts?.length).toBe(collect2.value.mounts?.length);
    expect(collect3.value.entities.length).toBe(collect2.value.entities.length);

    const m2 = collect2.value.mounts?.[0];
    const m3 = collect3.value.mounts?.[0];
    expect(m3?.source).toBe(m2?.source);
    expect(m3?.memberCount).toBe(m2?.memberCount);
  });

  it('double-layer: collect2 == collect3 from same reloaded tree (D-9 fixed-point)', () => {
    const reg = mkReg();
    const w = new World();

    const sceneC: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
    };
    cat(reg, G1, sceneC);

    const sceneB: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 10 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    const bSlots = computeTotalSlots(sceneB);
    cat(reg, G2, sceneB);

    const sceneA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 100 } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G2,
          memberFirst: 2 as never,
          memberCount: bSlots,
        },
      ],
    };
    cat(reg, G3, sceneA);
    const ha = rs(w, sceneA);

    // Collect 1.
    const inst = reg.instantiate(ha, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const collect1 = rootsToSceneAsset(reg, w, [inst.value]);
    expect(collect1.ok).toBe(true);
    if (!collect1.ok) return;

    // Serialize -> parse -> catalog -> reload.
    const serRes = serializeSceneAssetToPack(collect1.value, G4);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;

    const fn = accessParseScenePayload(reg);
    const parsed = fn('scene', unpacked.payload, unpacked.refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    cat(reg, G4, parsed);
    const reloadedHandle = rs(w, parsed);
    const inst2 = reg.instantiate(reloadedHandle, w);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Collect 2 (post-normalization).
    const collect2 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect2.ok).toBe(true);
    if (!collect2.ok) return;

    // Collect 3 (same live tree).
    const collect3 = rootsToSceneAsset(reg, w, [inst2.value]);
    expect(collect3.ok).toBe(true);
    if (!collect3.ok) return;

    // Fixed-point: collect2 == collect3.
    expect(scenesAreStructurallyEquivalent(collect2.value, collect3.value)).toBe(true);

    // Both must have identical mounts and entities.
    expect(collect3.value.mounts?.length).toBe(collect2.value.mounts?.length);
    expect(collect3.value.entities.length).toBe(collect2.value.entities.length);

    const sources2 = (collect2.value.mounts ?? []).map((m) => m.source as string).sort();
    const sources3 = (collect3.value.mounts ?? []).map((m) => m.source as string).sort();
    expect(sources3).toEqual(sources2);
  });
});
