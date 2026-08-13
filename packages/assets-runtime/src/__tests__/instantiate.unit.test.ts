// @forgeax/engine-assets-runtime -- AssetRegistry.instantiate / instantiateFlat
// coverage (fix issue #709). Drives the scene-instantiate collaboration module
// (instantiate.ts) end-to-end through a real World + the two-tier handle
// resolver. The assertions check the structured Result surface (charter P3:
// instantiate never throws for an expected failure) rather than a specific
// spawn outcome, so the coverage does not couple to the full ECS scene-spawn
// prerequisites (node env, no GPU).

import { defineComponent, World } from '@forgeax/engine-ecs';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { resolveAssetHandle } from '../resolve-asset-handle';

defineComponent('T709Tag', { value: 'f32' });
defineComponent('T709MaterialCarrier', { materials: 'array<shared<MaterialAsset>>' });

const MATERIAL_GUID = '11111111-1111-4111-8111-111111111111';
const CHILD_A_GUID = '22222222-2222-4222-8222-222222222222';
const CHILD_B_GUID = '33333333-3333-4333-8333-333333333333';
const PARENT_GUID = '44444444-4444-4444-8444-444444444444';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry({
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    installMaterialArtifact: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry);
}

function twoEntityScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: [
      { localId: 0 as never, components: { T709Tag: { value: 1 } } },
      { localId: 1 as never, components: { T709Tag: { value: 2 } } },
    ],
    mounts: [],
  } as unknown as SceneAsset;
}

function isResult(v: unknown): v is { ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

describe('AssetRegistry.instantiate', () => {
  it('resolves a catalogued scene handle and returns a structured Result', () => {
    const reg = makeRegistry();
    const world = new World();
    const scene = twoEntityScene();
    const handle = world.allocSharedRef('SceneAsset', scene);
    const res = reg.instantiate(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(typeof res.value).toBe('number');
  });

  it('returns an error Result when the handle does not resolve to a scene', () => {
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('SceneAsset', { kind: 'material' } as unknown as Asset);
    const res = reg.instantiate(handle as never, world);
    expect(res.ok).toBe(false);
  });
});

describe('AssetRegistry.instantiateFlat', () => {
  it('drives the flat scene-materialise path to a structured Result', () => {
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const res = reg.instantiateFlat(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(Array.isArray(res.value)).toBe(true);
  });
});

describe('scene graph GUID handle ownership', () => {
  it('mints one handle per GUID across sibling mount recursion', () => {
    const reg = makeRegistry();
    const world = new World();
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
    } as unknown as Asset;
    const child = (value: number): SceneAsset => ({
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            T709Tag: { value },
            T709MaterialCarrier: { materials: [MATERIAL_GUID] },
          },
        },
      ],
    });
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        { localId: 0 as never, source: CHILD_A_GUID, memberFirst: 1 as never, memberCount: 1 },
        { localId: 2 as never, source: CHILD_B_GUID, memberFirst: 3 as never, memberCount: 1 },
        { localId: 4 as never, source: CHILD_A_GUID, memberFirst: 5 as never, memberCount: 1 },
      ],
    };
    reg.catalog(MATERIAL_GUID, material);
    reg.catalog(CHILD_A_GUID, child(1));
    reg.catalog(CHILD_B_GUID, child(2));
    reg.catalog(PARENT_GUID, parent);

    const resolved = reg._resolveSceneGuids(parent, world, PARENT_GUID);

    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const childHandles = resolved.value.mounts?.map((mount) => mount.source) ?? [];
    expect(childHandles).toHaveLength(3);
    expect(childHandles[2]).toBe(childHandles[0]);
    const resolvedChildren = childHandles.map((handle) =>
      resolveAssetHandle<SceneAsset>(world, handle as never).unwrap(),
    );
    const materialHandles = resolvedChildren.map(
      (scene) =>
        (
          scene.entities[0]?.components as Record<
            string,
            { readonly materials?: readonly number[] }
          >
        ).T709MaterialCarrier?.materials?.[0],
    );
    expect(materialHandles[0]).toBeGreaterThanOrEqual(1024);
    expect(materialHandles[1]).toBe(materialHandles[0]);
    expect(materialHandles[2]).toBe(materialHandles[0]);
  });

  it('reuses a catalogued payload handle across separate scene resolutions', () => {
    const reg = makeRegistry();
    const world = new World();
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
    } as unknown as Asset;
    const scene: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            T709MaterialCarrier: { materials: [MATERIAL_GUID] },
          },
        },
      ],
    };
    expect(reg.catalog(MATERIAL_GUID, material).ok).toBe(true);

    const first = reg._resolveSceneGuids(scene, world);
    const second = reg._resolveSceneGuids(scene, world);

    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const handleOf = (resolved: SceneAsset): number | undefined =>
      (
        resolved.entities[0]?.components as Record<
          string,
          { readonly materials?: readonly number[] }
        >
      ).T709MaterialCarrier?.materials?.[0];
    expect(handleOf(second.value)).toBe(handleOf(first.value));
    expect(world.sharedRefs._liveCount()).toBe(1);
  });
});
