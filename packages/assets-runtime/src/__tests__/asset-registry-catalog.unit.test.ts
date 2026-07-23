import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

function registry(): AssetRegistry {
  return new AssetRegistry({} as never);
}

describe('AssetRegistry.enumerateCatalog', () => {
  it('shares concurrent reads and retries after a failed source read', async () => {
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'asset-fetch-failed' } })
      .mockResolvedValueOnce({ ok: true, value: [] });
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
});
