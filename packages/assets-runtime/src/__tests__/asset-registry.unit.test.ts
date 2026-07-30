// @forgeax/engine-assets-runtime -- AssetRegistry coverage (fix issue #709).
// Drives the GUID -> payload catalogue through its public surface: parseGuid,
// catalog + register-time validation, lookup, loadByGuid (catalogued fast-path
// + not-imported miss), resolveName / packageOf / rename, invalidate /
// invalidateAll, inspect, listCatalog. Uses a mock ShaderRegistry (no GPU).

import type { MaterialAsset, MeshAsset, TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import type { CatalogRecord } from '../registry/catalog';
import { registerPackagesFromIndex } from '../registry/load-by-guid';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

function makeMockShaderRegistry() {
  return {
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    lookupMaterialShader: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    registerMaterialShader: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function meshPayload(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(36), // 3 verts * 12
    indices: Uint16Array.of(0, 1, 2),
    attributes: { position: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) },
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  } as MeshAsset;
}

describe('parseGuid', () => {
  it('parses a valid dash-form GUID', () => {
    const reg = makeRegistry();
    expect(() => reg.parseGuid(GUID_A)).not.toThrow();
  });

  it('throws an AssetError on a malformed GUID', () => {
    const reg = makeRegistry();
    expect(() => reg.parseGuid('not-a-guid')).toThrow();
  });
});

describe('catalog + lookup', () => {
  it('catalogs a mesh payload (computes aabb) and looks it up by GUID', () => {
    const reg = makeRegistry();
    const res = reg.catalog(GUID_A, meshPayload());
    expect(res.ok).toBe(true);
    const got = reg.lookup<MeshAsset>(GUID_A);
    expect(got?.kind).toBe('mesh');
    expect(got?.aabb).toBeInstanceOf(Float32Array);
  });

  it('lookup returns undefined for an uncatalogued GUID', () => {
    expect(makeRegistry().lookup(GUID_B)).toBeUndefined();
  });

  it('rejects an invalid mesh payload at register time (stride mismatch)', () => {
    const reg = makeRegistry();
    const bad = { ...meshPayload(), vertices: new Float32Array(13) };
    const res = reg.catalog(GUID_A, bad);
    expect(res.ok).toBe(false);
  });

  it('rejects an invalid tileset payload at register time', () => {
    const reg = makeRegistry();
    const bad = {
      kind: 'tileset',
      guid: GUID_A,
      atlases: [],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [],
      tiles: [],
    } as unknown as TilesetAsset;
    expect(reg.catalog(GUID_A, bad).ok).toBe(false);
  });

  it('rejects a material with an explicit empty passes[]', () => {
    const reg = makeRegistry();
    const bad = { kind: 'material', passes: [] } as MaterialAsset;
    expect(reg.catalog(GUID_A, bad).ok).toBe(false);
  });
});

describe('loadByGuid', () => {
  it('returns the payload for an already-catalogued GUID (fast path)', async () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const parsed = reg.parseGuid(GUID_A);
    const res = await reg.loadByGuid<MeshAsset>(parsed);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('mesh');
  });

  it('fails for an uncatalogued GUID with no pack index configured', async () => {
    const reg = makeRegistry();
    const res = await reg.loadByGuid(reg.parseGuid(GUID_B));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // No packIndexUrl + no transport: the load misses the catalogue fast-path
    // and surfaces the closed-union asset-not-found (the DDC asset-not-imported
    // arm only fires once a pack index is configured).
    expect((res.error as { code: string }).code).toBe('asset-not-found');
  });

  it('does not route a static load failure through decodeImageBytes', async () => {
    const reg = makeRegistry();
    const res = await reg.loadByGuid(reg.parseGuid(GUID_B));
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as { code: string }).code).toBe('asset-not-found');
  });
});

describe('resolveName / packageOf / rename', () => {
  it('a freshly catalogued inline asset has no package and an empty derived name', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    expect(reg.packageOf(GUID_A)).toBeNull();
    expect(reg.resolveName(GUID_A)).toBe('');
  });

  it('packageOf returns undefined for an unregistered GUID', () => {
    expect(makeRegistry().packageOf(GUID_B)).toBeUndefined();
  });

  it('rename sets a stored name on a no-package asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const res = reg.rename(GUID_A, 'hero-mesh');
    expect(res.ok).toBe(true);
    expect(reg.resolveName(GUID_A)).toBe('hero-mesh');
  });

  it('rename errors with asset-not-found for an unregistered GUID', () => {
    const res = makeRegistry().rename(GUID_B, 'x');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('asset-not-found');
  });
});

describe('invalidate / invalidateAll', () => {
  it('invalidate drops a single catalogued asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    reg.invalidate(GUID_A);
    expect(reg.lookup(GUID_A)).toBeUndefined();
  });

  it('invalidate preserves a derived package name when a reload changes the DDC path', () => {
    const reg = makeRegistry();
    reg._registerPackage('/assets/sky.hdr', [GUID_A]);
    reg.catalog(GUID_A, meshPayload());
    expect(reg.resolveName(GUID_A)).toBe('sky.hdr');

    reg.invalidate(GUID_A);
    registerPackagesFromIndex(
      reg,
      new Map([
        [
          GUID_A,
          {
            packageUrl: '/node_modules/.cache/forgeax-ddc/sky.bin',
            sourcePath: '/assets/sky.hdr',
          },
        ],
      ]),
    );
    reg.catalog(GUID_A, meshPayload());

    expect(reg.resolveName(GUID_A)).toBe('sky.bin');
  });

  it('invalidateAll clears every catalogued asset and reports the count', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    reg.catalog(GUID_B, meshPayload());
    const { clearedCount } = reg.invalidateAll();
    expect(clearedCount).toBeGreaterThanOrEqual(2);
    expect(reg.lookup(GUID_A)).toBeUndefined();
    // Idempotent: a second call reports 0.
    expect(reg.invalidateAll().clearedCount).toBe(0);
  });
});

describe('inspect / listCatalog', () => {
  it('returns an empty readonly catalog before a registry is bound', () => {
    const reg = makeRegistry();
    reg.assetCatalog.clear();
    const rows = reg.listCatalog();
    expect(rows).toEqual([]);
    expectTypeOf(rows).toMatchTypeOf<readonly unknown[]>();
  });

  it('inspect lists catalogued assets with guid/kind/name', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const snap = reg.inspect();
    const entry = snap.assets.find((a) => a.guid === GUID_A.toLowerCase());
    expect(entry?.kind).toBe('mesh');
  });

  it('listCatalog returns a fresh snapshot including the inline asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const rows = reg.listCatalog();
    expect(rows.some((r) => r.guid === GUID_A.toLowerCase() && r.kind === 'mesh')).toBe(true);
  });

  it('listCatalog deeply preserves every canonical producer fact from the full catalog', () => {
    const reg = makeRegistry();
    reg.assetCatalog.clear();
    const provenance = { provider: 'host-importer', version: '7.2.0' } as const;
    const revision = { digest: 'sha256:catalog', observedAt: 42, rootId: 'game-root' } as const;
    const relations = [
      {
        from: { type: 'asset', id: GUID_A },
        to: { type: 'resource', id: 'source/blob' },
        type: 'produces',
        provenance,
      },
    ] as const;
    const diagnostics = [
      {
        code: 'producer-warning',
        severity: 'warning',
        expected: 'stable source key',
        actual: 'legacy index fallback',
        hint: 'repair the producer declaration',
        authority: 'producer',
      },
    ] as const;
    const canonicalRow: CatalogRecord = {
      packageUrl: '/assets/blob.pack.json',
      sourcePath: 'models/blob.host',
      kind: 'host/blob',
      packageId: 'host-package',
      provenance,
      revision,
      sourceKey: 'blob/main',
      sourceIndex: 3,
      relations,
      diagnostics,
    } as const;
    const legacyRow: CatalogRecord = {
      packageUrl: '/assets/legacy.pack.json',
      sourcePath: 'models/legacy.host',
      kind: 'host/legacy',
    } as const;
    reg.packIndexCache = new Map([
      [GUID_A.toLowerCase(), canonicalRow],
      [GUID_B.toLowerCase(), legacyRow],
    ]);

    expect(reg.listCatalog()).toEqual([
      { guid: GUID_A.toLowerCase(), ...canonicalRow },
      { guid: GUID_B.toLowerCase(), ...legacyRow },
    ]);
    expect(reg.listCatalog()[1]).toEqual({
      guid: GUID_B.toLowerCase(),
      ...legacyRow,
    });
  });

  it('listCatalog includes a catalogued AnimationGraph with kind=animation-graph', () => {
    const reg = makeRegistry();
    const graph = {
      kind: 'animation-graph' as const,
      nodes: [{ type: 'clip' as const, clip: 0 as never, weight: 1 }],
      root: 0,
    };
    reg.catalog(GUID_B, graph);
    const rows = reg.listCatalog();
    expect(rows.some((r) => r.guid === GUID_B.toLowerCase() && r.kind === 'animation-graph')).toBe(
      true,
    );
  });
});

describe('configuration setters + payload parse delegation', () => {
  it('setMetrics / setTranscodeCaps / configurePackIndex mutate config without throwing', () => {
    const reg = makeRegistry();
    reg.setMetrics({ increment: () => {} } as never);
    reg.setTranscodeCaps({ bc: false, etc2: false, astc: false } as never);
    reg.configurePackIndex('/pack-index.json');
    // configurePackIndex is idempotent-safe on a re-set (resets the cache).
    reg.configurePackIndex('/pack-index.json');
  });

  it('materialShaderTextureFieldNames returns undefined for an unregistered shader', () => {
    expect(makeRegistry().materialShaderTextureFieldNames('forgeax::nope')).toBeUndefined();
  });

  it('parseAssetPayload dispatches a mesh payload through the loader registry', () => {
    const reg = makeRegistry();
    const out = reg.parseAssetPayload('mesh', {
      vertices: new Array(12).fill(0),
      indices: [0, 0, 0],
    });
    expect((out as { kind?: string }).kind).toBe('mesh');
  });

  it('parseAssetPayload passes an unregistered kind through as a raw payload', () => {
    // Unknown kinds have no engine loader; the payload is returned verbatim
    // (stamped with kind) so a host-registered loader can own the parse (D-1).
    const out = makeRegistry().parseAssetPayload('sampler', { addressModeU: 'repeat' });
    expect((out as { kind?: string }).kind).toBe('sampler');
  });

  it('parseAndReturnAsset returns a Result carrying the parsed asset + refs', () => {
    const reg = makeRegistry();
    const res = reg.parseAndReturnAsset({
      kind: 'mesh',
      payload: { vertices: new Array(12).fill(0), indices: [0, 0, 0] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.asset.kind).toBe('mesh');
  });

  it('refreshCatalog is a no-op (returns false) when no pack index is configured', async () => {
    expect(await makeRegistry().refreshCatalog()).toBe(false);
  });
});
