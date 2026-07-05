// asset-registry-guid-reverse.test.ts — M1 origin-index reverse-lookup TDD
// (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).
//
// m1-t1: HIT path — after catalog + AssetRegistry.instantiate, the resolved
//   copy payload is reachable via world.getSceneAssetForInstance +
//   resolveAssetHandle, and _guidForAsset(copy) should return the original
//   catalog GUID (currently RED — Finding 1 MISS).
//
// m1-t2: MISS path — an uncatalogued, hand-assembled SceneAsset
//   allocated via world.allocSharedRef and instantiated still returns
//   undefined from _guidForAsset (AC-05 structural error path); also
//   rootsToSceneAsset on uncatalogued shared refs produces
//   SceneCollectAssetGuidUnresolvedError with complete .code / .expected /
//   .hint / .detail fields.

import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import '../components/scene-instance';
import { type Asset, AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { SceneCollectAssetGuidUnresolvedError } from '../errors';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makeScene(entities?: SceneAsset['entities']): SceneAsset {
  return {
    kind: 'scene',
    entities: entities ?? [{ localId: 0 as never, components: { Transform: {} } }],
  };
}

const GUID_A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

// ── m1-t1: HIT path ─────────────────────────────────────────────────────

describe('m1-t1 — origin index reverse-lookup HIT', () => {
  it('_guidForAsset on instantiate-resolved copy returns the original catalog GUID', () => {
    const reg = makeReg();
    const world = new World();

    // Catalog the scene asset.
    const scene = makeScene();
    reg.catalog(parseGuid(GUID_A), scene);

    // Allocate a shared ref from the world (the column-handle path).
    const handle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', scene);

    // Instantiate via AssetRegistry.
    const instRes = reg.instantiate(handle, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    const root = instRes.value;

    // Get the SceneInstance's source handle and resolve to payload.
    const srcHandleRes = world.getSceneAssetForInstance(root);
    expect(srcHandleRes.ok).toBe(true);
    if (!srcHandleRes.ok) return;
    const srcHandle = srcHandleRes.value;

    const payloadRes = resolveAssetHandle<SceneAsset>(
      world,
      srcHandle as unknown as Handle<string, 'shared'>,
    );
    expect(payloadRes.ok).toBe(true);
    if (!payloadRes.ok) return;
    const copyPayload = payloadRes.value;

    // The copy is a different object from the catalogued original
    // (_resolveSceneGuids produces a deep copy).
    expect(copyPayload).not.toBe(scene);

    // Should return the catalog GUID after m1-i1; currently RED (undefined).
    const guid = reg._guidForAsset(copyPayload as Asset);
    expect(guid).toBe(GUID_A);
  });
});

// ── m1-t2: MISS path ────────────────────────────────────────────────────

describe('m1-t2 — uncatalogued scene MISS path', () => {
  it('_guidForAsset on uncatalogued payload returns undefined', () => {
    const reg = makeReg();
    const scene = makeScene();

    // Never catalogued; just allocate a shared ref directly.
    const guid = reg._guidForAsset(scene as Asset);
    expect(guid).toBeUndefined();
  });

  it('rootsToSceneAsset on uncatalogued shared ref fails with SceneCollectAssetGuidUnresolvedError', () => {
    const reg = makeReg();
    const world = new World();

    // Construct a scene with an entity that carries a shared<> field
    // referencing an uncatalogued MeshAsset (never catalogued).
    // world.allocSharedRef for the MeshAsset creates a user-tier handle,
    // but _guidForAsset has no catalogue entry for it.
    const mesh: Asset = {
      kind: 'mesh',
      vertices: new Float32Array(12 * 3),
      indices: new Uint16Array([0, 1, 2]),
    } as unknown as Asset;

    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            MeshFilter: { assetHandle: meshHandle as never },
            Transform: {},
          },
        },
      ],
    };

    // Allocate shared ref for the scene and instantiate.
    const sceneHandle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', asset);
    const instRes = world.instantiateScene(sceneHandle);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    const root = instRes.value.root;

    // rootsToSceneAsset should fail-fast with the structured error.
    const res = rootsToSceneAsset(reg, world, [root]);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    const err = res.error;
    expect(err).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
    expect(err.code).toBe('scene-collect-asset-guid-unresolved');
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(err.detail).toBeDefined();
    expect(typeof err.detail.field).toBe('string');
    // detail.handle is optional on SceneCollectAssetGuidUnresolvedDetail;
    // the collect path emits handle (not guid).
    const detail = err.detail as { field: string; handle?: number; guid?: string };
    expect(typeof detail.handle).toBe('number');
  });
});
