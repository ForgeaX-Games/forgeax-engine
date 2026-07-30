import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';

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
});
