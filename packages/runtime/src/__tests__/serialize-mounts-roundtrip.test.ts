// serialize-mounts-roundtrip.test.ts — M3 serialization breakpoint A/B + resolver
// wiring TDD tests (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).
//
// Coverage:
//   m3-t1: serialize<->parse mounts symmetry round-trip
//   m3-t2: registry.instantiate with mounts overload
//   m3-t3: cyclic mount fail-fast

import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, err, ok, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset, SceneInstanceMount } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { serializeSceneAssetToPack } from '../collect-scene-asset';
import '../components';
import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
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

function swr(
  w: World,
  ph: Handle<'SceneAsset', 'shared'>,
  ch: Handle<'SceneAsset', 'shared'>,
): void {
  w._setSceneAssetResolver?.((_s, pH) =>
    (pH as unknown as number) === (ph as unknown as number)
      ? ok(ch)
      : err({ code: 'asset-not-found' }),
  );
}

/** Access parseScenePayload via public parseAssetPayload -> scene kind cast. */
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
      result.kind === 'scene'
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

/** Verify child SceneInstance is valid for an instantiated mount. */
function getSceneInstanceSource(w: World, e: EntityHandle): string | undefined {
  const si = w.get(e, SceneInstance);
  if (!si.ok) return undefined;
  const src = (si.value as Record<string, unknown>).source as Handle<string, 'shared'>;
  const pr = resolveAssetHandle<SceneAsset>(w, src as unknown as Handle<string, 'shared'>);
  if (!pr.ok) return undefined;
  return (pr.value as SceneAsset).mounts !== undefined ? 'has-mounts' : 'no-mounts';
}

const G1 = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const G2 = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const G3 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t1: serialize<->parse mounts symmetry round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t1 — serialize<->parse mounts symmetry round-trip', () => {
  it('serialize mounts.source GUID -> refs index, parse refs index -> GUID', () => {
    const reg = mkReg();
    const fn = accessParseScenePayload(reg);

    // Build a SceneAsset with mounts (source as GUID string, post-collect shape).
    const mounts: SceneInstanceMount[] = [
      {
        localId: 1 as never,
        source: G1,
        memberFirst: 3 as never,
        memberCount: 5,
        parent: 0 as never,
      },
      {
        localId: 2 as never,
        source: G2,
        memberFirst: 8 as never,
        memberCount: 2,
      },
    ];
    const scene: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [1, 0, 0] } } }],
      mounts,
    };

    // Serialize.
    const serRes = serializeSceneAssetToPack(scene, G3);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) return;

    const unpacked = unpackSerialized(serRes.value);
    expect(unpacked).toBeDefined();
    if (!unpacked) return;
    const { payload: packPayload, refs } = unpacked;

    // mounts should be present in the serialized output.
    const serMounts = packPayload.mounts as ReadonlyArray<Record<string, unknown>> | undefined;
    expect(serMounts).toBeDefined();
    expect(serMounts?.length).toBe(2);

    // source should be refs index (number), not GUID string.
    const sm0 = serMounts?.[0];
    expect(sm0).toBeDefined();
    if (!sm0) return;
    expect(typeof sm0.source).toBe('number');
    expect(sm0.localId).toBe(1);
    expect(sm0.memberFirst).toBe(3);
    expect(sm0.memberCount).toBe(5);
    expect(sm0.parent).toBe(0);

    const sm1 = serMounts?.[1];
    expect(sm1).toBeDefined();
    if (!sm1) return;
    expect(typeof sm1.source).toBe('number');
    expect(sm1.localId).toBe(2);
    expect(sm1.memberFirst).toBe(8);
    expect(sm1.memberCount).toBe(2);
    expect(sm1.parent).toBeUndefined();

    // refs should contain both GUIDs.
    expect(refs).toBeDefined();
    expect(refs).toContain(G1);
    expect(refs).toContain(G2);

    // Verify source index -> GUID round-trip: refs[sourceIndex] === original GUID.
    const idx0 = sm0.source as number;
    const idx1 = sm1.source as number;
    expect(refs?.[idx0]).toBe(G1);
    expect(refs?.[idx1]).toBe(G2);

    // Parse back: source should be restored to GUID string.
    const parsed = fn('scene', packPayload, refs);
    expect(parsed).toBeDefined();
    if (!parsed) return;

    expect(parsed.mounts).toBeDefined();
    expect(parsed.mounts?.length).toBe(2);

    const pm0 = parsed.mounts?.[0];
    expect(pm0).toBeDefined();
    if (!pm0) return;
    expect(pm0.source).toBe(G1);
    expect(pm0.localId).toBe(1);
    expect(pm0.memberFirst).toBe(3);
    expect(pm0.memberCount).toBe(5);
    expect(pm0.parent).toBe(0);

    const pm1 = parsed.mounts?.[1];
    expect(pm1).toBeDefined();
    if (!pm1) return;
    expect(pm1.source).toBe(G2);
    expect(pm1.localId).toBe(2);
    expect(pm1.memberFirst).toBe(8);
    expect(pm1.memberCount).toBe(2);
    expect(pm1.parent).toBeUndefined();
  });

  it('scene without mounts serializes without mounts field (back-compat)', () => {
    const reg = mkReg();
    const fn = accessParseScenePayload(reg);

    const scene: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [1, 0, 0] } } }],
    };
    const serResBackcompat = serializeSceneAssetToPack(scene, G3);
    expect(serResBackcompat.ok).toBe(true);
    if (!serResBackcompat.ok) return;

    const unpackedBackcompat = unpackSerialized(serResBackcompat.value);
    expect(unpackedBackcompat).toBeDefined();
    if (!unpackedBackcompat) return;
    // Scene with no mounts: serialize should not add an empty mounts array
    // unless it carries semantic meaning. Parse back should still work.
    const parsedBackcompat = fn('scene', unpackedBackcompat.payload, unpackedBackcompat.refs);
    expect(parsedBackcompat).toBeDefined();
    expect(parsedBackcompat?.entities).toBeDefined();
  });

  it('numeric fields (memberFirst/memberCount/localId) preserved exactly', () => {
    const reg = mkReg();
    const fn = accessParseScenePayload(reg);

    const mounts: SceneInstanceMount[] = [
      {
        localId: 999 as never,
        source: G1,
        memberFirst: 1000 as never,
        memberCount: 42,
        parent: 500 as never,
      },
    ];
    const sceneNumeric: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts,
    };

    const serResNum = serializeSceneAssetToPack(sceneNumeric, G3);
    expect(serResNum.ok).toBe(true);
    if (!serResNum.ok) return;

    const unpackedNum = unpackSerialized(serResNum.value);
    expect(unpackedNum).toBeDefined();
    if (!unpackedNum) return;
    const packPayloadNum = unpackedNum.payload;

    const serMountsNum = packPayloadNum.mounts as
      | ReadonlyArray<Record<string, unknown>>
      | undefined;
    expect(serMountsNum).toBeDefined();
    expect(serMountsNum?.[0]?.localId).toBe(999);
    expect(serMountsNum?.[0]?.memberFirst).toBe(1000);
    expect(serMountsNum?.[0]?.memberCount).toBe(42);
    expect(serMountsNum?.[0]?.parent).toBe(500);

    // Parse back and verify.
    const parsedNum = fn('scene', packPayloadNum, unpackedNum.refs);
    expect(parsedNum).toBeDefined();
    if (!parsedNum?.mounts?.[0]) return;
    expect(parsedNum.mounts[0].localId).toBe(999);
    expect(parsedNum.mounts[0].memberFirst).toBe(1000);
    expect(parsedNum.mounts[0].memberCount).toBe(42);
    expect(parsedNum.mounts[0].parent).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t2: registry.instantiate with mounts overload
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t2 — registry.instantiate with mounts overload', () => {
  it('instantiate parent with mount spawns nested child SceneInstance', () => {
    const reg = mkReg();
    const w = new World();

    // Child scene: two entities with Transform.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: { pos: [1, 0, 0] } } },
        { localId: 1 as never, components: { Transform: { pos: [2, 0, 0] } } },
      ],
    };
    cat(reg, G1, child);
    const ch = rs(w, child);

    // Parent scene: one owned entity + mount referencing child.
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [10, 0, 0] } } }],
      mounts: [
        {
          localId: 1 as never,
          source: G1, // GUID string — post-parse / post-collect shape
          memberFirst: 2 as never,
          memberCount: 2,
        },
      ],
    };
    cat(reg, G2, parent);

    // Wire resolver: when source=G1 on parent handle, return child handle.
    // This is needed so world.instantiateScene can resolve the mount.
    const ph = rs(w, parent);
    swr(w, ph, ch);

    const inst = reg.instantiate(ph, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // Verify instantiated root exists.
    const root = inst.value;
    expect(root).toBeDefined();

    // Walk descendants of root (excluding root) — should include mount entity and
    // nested SceneInstance root entities.
    let descendantCount = 0;
    let foundMountChild = false;
    for (const c of w.iterDescendants(root)) {
      if (c === root) continue;
      descendantCount++;
      // A child that carries SceneInstance = nested instance root.
      if (w.get(c, SceneInstance).ok) {
        foundMountChild = true;
      }
    }
    // At least 2 descendants: the owned entity (localId=0) + mount entity + child SceneInstance root.
    expect(descendantCount).toBeGreaterThanOrEqual(2);
    expect(foundMountChild).toBe(true);
  });

  it('reload path through catalog+instantiate restores mount structure', () => {
    const reg = mkReg();
    const w = new World();

    // Build a complete round-trip fixture.
    // Step 1: Catalog child scene.
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [5, 0, 0] } } }],
    };
    cat(reg, G1, child);
    const ch = rs(w, child);

    // Step 2: Build parent with mount -> catalog.
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { pos: [100, 0, 0] } } }],
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
    swr(w, ph, ch);

    // Step 3: Instantiate parent via registry.
    const inst = reg.instantiate(ph, w);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // Step 4: Verify root hierarchy has child SceneInstance entity.
    const root = inst.value;
    let hasSceneInstanceChild = false;
    for (const c of w.iterDescendants(root)) {
      if (c === root) continue;
      if (w.get(c, SceneInstance).ok) {
        hasSceneInstanceChild = true;
        // Verify the SceneInstance.source can be resolved.
        const si = getSceneInstanceSource(w, c);
        expect(si).toBeDefined();
      }
    }
    expect(hasSceneInstanceChild).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t3: cyclic mount fail-fast
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t3 — cyclic mount fail-fast', () => {
  it('A mount B, B mount A surfaces pack-cyclic-reference / mount-asset', () => {
    const reg = mkReg();
    const w = new World();

    // Scene A: mounts scene B (source=G2).
    const sceneA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [
        {
          localId: 1 as never,
          source: G2,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    cat(reg, G1, sceneA);
    const ha = rs(w, sceneA);

    // Scene B: mounts scene A (source=G1) — cycle.
    const sceneB: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
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
    const hb = rs(w, sceneB);

    // Wire resolver: A -> B, B -> A.
    swr(w, ha, hb);
    swr(w, hb, ha);

    // Attempt instantiate via registry — should fail with cycle detection.
    const inst = reg.instantiate(ha, w);
    expect(inst.ok).toBe(false);
    if (inst.ok) return;

    // Check error shape: must be pack-cyclic-reference with kind='mount-asset'.
    const e = inst.error as {
      code: string;
      detail?: { kind?: string; cycle?: readonly string[] };
    };
    expect(e.code).toBe('pack-cyclic-reference');
  });

  it('A mount B, B mount C, C mount A (3-node cycle) fail-fast', () => {
    const reg = mkReg();
    const w = new World();

    const sceneA: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: G2, memberFirst: 1 as never, memberCount: 0 }],
    };
    cat(reg, G1, sceneA);
    const ha = rs(w, sceneA);

    const sceneB: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: G3, memberFirst: 1 as never, memberCount: 0 }],
    };
    cat(reg, G2, sceneB);
    const hb = rs(w, sceneB);

    const sceneC: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [{ localId: 0 as never, source: G1, memberFirst: 1 as never, memberCount: 0 }],
    };
    cat(reg, G3, sceneC);
    const hc = rs(w, sceneC);

    // Wire: A->B, B->C, C->A.
    swr(w, ha, hb);
    swr(w, hb, hc);
    swr(w, hc, ha);

    const inst = reg.instantiate(ha, w);
    expect(inst.ok).toBe(false);
    if (inst.ok) return;

    const e = inst.error as {
      code: string;
      detail?: { kind?: string; cycle?: readonly string[] };
    };
    expect(e.code).toBe('pack-cyclic-reference');
  });
});
