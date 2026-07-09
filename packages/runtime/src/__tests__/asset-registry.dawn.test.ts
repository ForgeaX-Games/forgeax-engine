// w13 - AssetRegistry Node path (loadByGuid + GUID-keyed catalog API).
//
// Migration from load(url) to loadByGuid (feat-20260513-guid-asset-package-system w13).
// feat-20260614 M8 (D-17): the registry catalogues GUID -> payload and
// `loadByGuid` returns the PAYLOAD (no handle); column minting moved to
// `world.allocSharedRef`, handle->payload resolution to `resolveAssetHandle`.
// Covers catalog + loadByGuid ok path + payload idempotency + asset-not-found
// error path on missing GUID + asset-not-found on an unresolvable handle.

import { AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, TextureAsset, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_DAWN_A = '00000000-0000-7000-8000-000000000031';
const GUID_DAWN_B = '00000000-0000-7000-8000-000000000032';

function makeMesh(): TypesMeshAsset {
  return {
    kind: 'mesh',
    // 1 vertex * 12F canonical layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)
    vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 1,
        vertexCount: 12,
        topology: 'triangle-list',
      },
    ],
  };
}

describe('w13 - AssetRegistry Node loadByGuid happy path', () => {
  it('loadByGuid() returns Ok(payload) for a catalogued GUID', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const mesh = makeMesh();
    reg.catalog<TypesMeshAsset>(guid, mesh);
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('mesh');
  });

  it('two loadByGuid(sameGuid) calls return same payload (idempotent)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    reg.catalog<TypesMeshAsset>(guid, makeMesh());
    const a = await reg.loadByGuid<TypesMeshAsset>(guid);
    const b = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).toBe(b.value);
    }
  });
});

describe('w13 - AssetRegistry Node error paths (AC-03 migration)', () => {
  it('asset-not-found: loadByGuid(unregistered guid)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_B);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('asset-not-found');
  });

  it('asset-not-found: resolveAssetHandle(unallocated gen-0 handle)', () => {
    const world = new World();
    // gen-0 user-tier handle for a never-allocated slot: passes the generation
    // gate (storeGen defaults to 0) then misses the payload -> asset-not-found.
    // (A gen>0 handle would instead surface 'shared-ref-stale' per D-3/AC-10 —
    // see asset.unit.test.ts "unresolvable handle: stale error forwarded".)
    const fake = toShared<'TextureAsset'>(99999);
    const res = resolveAssetHandle<TextureAsset>(world, fake as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('asset-not-found');
  });
});
