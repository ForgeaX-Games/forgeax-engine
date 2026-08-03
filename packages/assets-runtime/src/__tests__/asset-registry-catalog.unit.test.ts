import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { parseCatalog } from '../registry/catalog';

function registry(): AssetRegistry {
  return new AssetRegistry({} as never);
}

const packageRow = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  sourcePath: 'model.glb',
  packageUrl: '/preview/packages/model',
};

describe('AssetRegistry.enumerateCatalog', () => {
  it('exposes packageUrl navigation from the configured catalog source', async () => {
    const assets = registry();
    assets.setCatalogSource({
      enumerate: async () => ok([packageRow]),
      subscribe: () => () => {},
    });

    const result = await assets.enumerateCatalog();

    expect(result).toEqual({ ok: true, value: [packageRow] });
  });

  it('shares concurrent reads and retries after a failed source read', async () => {
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'asset-fetch-failed' } })
      .mockResolvedValueOnce(ok([]));
    const source = { enumerate, subscribe: () => () => {} };
    const assets = registry();
    assets.setCatalogSource(source);

    const [first, second] = await Promise.all([
      assets.enumerateCatalog(),
      assets.enumerateCatalog(),
    ]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect((await assets.enumerateCatalog()).ok).toBe(true);
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it('returns the complete neutral entry from a catalog source', async () => {
    const entry = {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'host/blob',
      packageUrl: '/assets/blob.bin',
      sourcePath: 'assets/blob.source',
      packageId: 'pkg/registry',
      provenance: { provider: 'registry-fixture', version: '1.0.0' },
      revision: { digest: 'sha256:registry', observedAt: 5, rootId: 'root-registry' },
      sourceKey: 'blob/main',
      sourceIndex: 0,
      relations: [],
      diagnostics: [{ code: 'registry-note', severity: 'info', hint: 'no action' }],
    } as const;
    const assets = registry();
    assets.setCatalogSource(createCatalogSource({ entries: [entry] }));

    const result = await assets.enumerateCatalog();

    expect(result).toEqual({ ok: true, value: [entry] });
  });

  it('preserves the explicit runtime projection instead of inferring it from locators', () => {
    const guid = '33333333-3333-4333-8333-333333333333';
    const raw = [
      {
        guid,
        packageUrl: '/opaque/runtime/asset.ddc',
        kind: 'particle-effect',
        sourcePath: 'authoring/boss.pack.json',
        subject: 'internal-asset',
        execution: 'cooked',
        lifecycle: 'current',
        projection: {
          subject: 'internal-asset',
          execution: 'cooked',
          lifecycle: 'current',
          operations: {
            preview: { operation: 'preview', enabled: true },
            save: { operation: 'save', enabled: false, reason: 'cooked projection' },
            rebuild: { operation: 'rebuild', enabled: true },
            sourceOverride: { operation: 'sourceOverride', enabled: false },
            instanceOverride: { operation: 'instanceOverride', enabled: false },
            promote: { operation: 'promote', enabled: false },
          },
        },
      },
    ];

    const result = parseCatalog(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get(guid)?.subject).toBe('internal-asset');
    expect(result.value.get(guid)?.execution).toBe('cooked');
    expect(result.value.get(guid)?.lifecycle).toBe('current');
    expect(result.value.get(guid)?.projection).toEqual(raw[0]?.projection);
  });

  it('keeps non-current cooked states explicit even when the locator looks runnable', () => {
    const guid = '44444444-4444-4444-8444-444444444444';
    const result = parseCatalog([
      {
        guid,
        packageUrl: '/opaque/runtime/asset.pack.json',
        kind: 'scene',
        sourcePath: 'authoring/scene.pack.json',
        subject: 'internal-asset',
        execution: 'cooked',
        lifecycle: 'stale',
        projection: {
          subject: 'internal-asset',
          execution: 'cooked',
          lifecycle: 'stale',
          operations: {
            preview: { operation: 'preview', enabled: true },
            save: { operation: 'save', enabled: false },
            rebuild: { operation: 'rebuild', enabled: true },
            sourceOverride: { operation: 'sourceOverride', enabled: false },
            instanceOverride: { operation: 'instanceOverride', enabled: false },
            promote: { operation: 'promote', enabled: false },
          },
          lastKnownGood: { packageUrl: '/opaque/runtime/old.pack.json' },
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.get(guid);
    expect(row?.lifecycle).toBe('stale');
    expect(row?.projection?.lastKnownGood?.packageUrl).toBe('/opaque/runtime/old.pack.json');
  });
});
