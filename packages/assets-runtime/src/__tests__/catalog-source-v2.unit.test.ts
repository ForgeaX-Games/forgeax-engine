import { describe, expect, it, vi } from 'vitest';
import { createCatalogSource } from '../catalog-source.js';
import { parseCatalog } from '../registry/catalog.js';

const packageRow = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  sourcePath: 'model.glb',
  packageUrl: '/preview/packages/model',
};

describe('catalog source v2', () => {
  it('parses packageUrl navigation without reading artifact bytes', () => {
    const resolveUrl = vi.fn((url: string) => `https://example.test${url}`);
    const result = parseCatalog([packageRow], resolveUrl);

    expect(result).toEqual({
      ok: true,
      value: new Map([
        [
          packageRow.guid,
          {
            packageUrl: 'https://example.test/preview/packages/model',
            kind: 'mesh',
            sourcePath: 'model.glb',
          },
        ],
      ]),
    });
    expect(resolveUrl).toHaveBeenCalledWith('/preview/packages/model');
  });

  it.each([
    ['missing packageUrl', { ...packageRow, packageUrl: undefined }],
    ['legacy relativeUrl', { ...packageRow, packageUrl: undefined, relativeUrl: '/asset.bin' }],
    ['legacy compression', { ...packageRow, compression: 'zstd' }],
    ['raw source package', { ...packageRow, packageUrl: '/assets/model.glb' }],
  ])('rejects %s as a structured catalog failure', (_label, row) => {
    const result = parseCatalog([row]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
  });

  it('does not fetch an artifact while parsing catalog rows', () => {
    const fetchArtifact = vi.fn();
    const result = parseCatalog([packageRow]);

    expect(result.ok).toBe(true);
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it('fetches only the catalog source and preserves package navigation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [packageRow] });
    const source = createCatalogSource({ url: '/preview/pack-index.json', fetch });

    const result = await source.enumerate();

    expect(result).toEqual({ ok: true, value: [packageRow] });
    expect(fetch).toHaveBeenCalledWith('/preview/pack-index.json');
  });
});
