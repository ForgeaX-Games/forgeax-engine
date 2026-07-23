import type { CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogSource } from '../catalog-source';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  name: 'unloaded',
  relativeUrl: '/assets/unloaded.pack.json',
  sourcePath: 'assets/unloaded.glb',
};

describe('CatalogSource', () => {
  it('enumerates every development or build row without loading its payload', async () => {
    for (const url of ['/__pack/index', '/pack-index.json']) {
      const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [entry] });
      const source = createCatalogSource({ url, fetch });
      const result = await source.enumerate();

      expect(result).toEqual({ ok: true, value: [entry] });
      expect(fetch).toHaveBeenCalledWith(url);
    }
  });

  it('reports an unconfigured source instead of an empty catalog', async () => {
    const result = await createCatalogSource({}).enumerate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('catalog-source-unconfigured');
  });

  it('uses the shared parser to distinguish malformed JSON from a fetch failure', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    const result = await createCatalogSource({ url: '/pack-index.json', fetch }).enumerate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
  });

  it('uses an idempotent no-op subscription for static catalogs', () => {
    const source = createCatalogSource({ entries: [entry] });
    const listener = vi.fn();
    const dispose = source.subscribe(listener);

    dispose();
    dispose();
    expect(listener).not.toHaveBeenCalled();
  });

  it('forwards an optional catalog subscription', () => {
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const source = createCatalogSource({ subscribe });

    expect(source.subscribe(listener)).toBe(unsubscribe);
    expect(subscribe).toHaveBeenCalledWith(listener);
  });
});
