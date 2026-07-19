// @forgeax/engine-assets-runtime -- buildSceneChildContext coverage (fix issue
// #709). The breadcrumb-provenance resolver walks the recursing scene's
// envelope.refs edges (prod) or falls back to the entity component walk (dev
// catalog()) to recover the (entityLocalId, component.field) path for a
// sub-asset GUID. Driven through an AssetRegistry with a mock ShaderRegistry.

import { defineComponent } from '@forgeax/engine-ecs';
import type { Asset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { buildSceneChildContext } from '../registry/instantiate';

defineComponent('T709CtxMeshFilter', { assetHandle: 'shared<MeshAsset>' });

function makeRegistry(): AssetRegistry {
  return new AssetRegistry({
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    lookupMaterialShader: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    registerMaterialShader: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry);
}

const SUB_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sceneWithMeshRef(): Asset & { kind: 'scene' } {
  return {
    kind: 'scene',
    entities: [{ localId: 7, components: { T709CtxMeshFilter: { assetHandle: SUB_GUID } } }],
    mounts: [],
  } as unknown as Asset & { kind: 'scene' };
}

describe('buildSceneChildContext', () => {
  it('recovers entityLocalId + component.field via the entity walk fallback', () => {
    const reg = makeRegistry();
    const ctx = buildSceneChildContext(reg, sceneWithMeshRef(), SUB_GUID.toLowerCase());
    expect(ctx?.sceneEntityId).toBe(7);
    expect(ctx?.componentField).toBe('T709CtxMeshFilter.assetHandle');
    expect(ctx?.sourceField).toMatchObject({
      componentName: 'T709CtxMeshFilter',
      fieldName: 'assetHandle',
    });
  });

  it('returns undefined when the sub-asset GUID is not referenced by any entity', () => {
    const reg = makeRegistry();
    const ctx = buildSceneChildContext(
      reg,
      sceneWithMeshRef(),
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    expect(ctx).toBeUndefined();
  });
});
