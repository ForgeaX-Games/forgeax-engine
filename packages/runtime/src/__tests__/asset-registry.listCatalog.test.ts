// w1 TDD: listCatalog unit test (plan-strategy section 2 D1)
//
// Test-first approach — call listCatalog() before it exists on AssetRegistry,
// confirming the TDD "red" phase via TypeScript compile error (TS2339).
// w2 will add the implementation and turn these tests green.
//
// plan-strategy section 2 D1 (engine export for AC-03 asset panel enumeration);
// requirements AC-03 (asset panel = engine truth, no parallel discovery);
// research Finding 5 (AssetRegistry public API is all guid point-lookup;
// assetCatalog/packIndexCache are private — no enumeration primitive exists yet).

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makeMeshFixture(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(36),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
    ],
  } as unknown as MeshAsset;
}

describe('D-1 listCatalog() (TDD: red before w2 impl)', () => {
  it('returns non-empty array for catalogued assets matching inspect() truth', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const mesh = makeMeshFixture();
    reg.catalog(guid, mesh);

    const list = reg.listCatalog();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);

    const found = list.find(
      (e: { guid: string; kind: string; name?: string; relativeUrl: string }) =>
        e.guid === guid.toLowerCase(),
    );
    expect(found).toBeDefined();
    expect(found?.guid).toBe(guid.toLowerCase());
    expect(found?.kind).toBe('mesh');
    // name derived via resolveName (empty for no-package catalogued asset)
    expect(found).toHaveProperty('name');
    expect(found).toHaveProperty('relativeUrl');
  });

  it('returns empty array for a registry with zero catalogued assets (boundary E3)', () => {
    const reg = makeReg();
    // Fresh registry still has builtins. Clear them via invalidateAll.
    reg.invalidateAll();
    const list = reg.listCatalog();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });

  it('returns a snapshot — two calls return distinct array objects (no internal Map leak, charter P4)', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const mesh = makeMeshFixture();
    reg.catalog(guid, mesh);

    const first = reg.listCatalog();
    const firstLen = first.length;

    const second = reg.listCatalog();
    expect(second.length).toBe(firstLen);
    // Snapshot identity: two calls return distinct array objects
    // (no internal Map reference leak — charter P4).
    expect(first).not.toBe(second);
  });
});
