import { decodeCatalogWire, encodeCatalogWire } from '@forgeax/engine-pack';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { parseCatalog } from '../registry/catalog.js';

const indexUrl = 'https://catalog.invalid/pack-index.json';
const packageUrl = 'https://catalog.invalid/assets/samplers.pack.json';
const guids = ['01900000-0000-7000-8000-000000000a01', '01900000-0000-7000-8000-000000000a02'];
const published = createRuntimePackPublication({
  scopeId: 'compact-catalog-fixture',
  sourcePath: 'assets/samplers.pack.ts',
  sourceRevision: 'fixture-revision',
  packageUrl,
  pack: {
    assets: guids.map((guid) => ({
      guid,
      kind: 'sampler',
      payload: { kind: 'sampler', magFilter: 'linear' },
      refs: [],
      artifacts: {},
    })),
  },
});
const rows = published.publication.outputs.map((output) => ({
  guid: output.guid,
  kind: output.kind,
  sourcePath: published.publication.sourcePath,
  packageUrl,
  refs: output.refs,
  sourceKey: output.sourceKey,
  publication: published.publication,
}));

it('loads both real Pack siblings through the compact HTTP catalog and complete publication', async () => {
  const wire = JSON.stringify(encodeCatalogWire(rows));
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === indexUrl) return new Response(wire);
    if (url === packageUrl) return new Response(JSON.stringify(published.pack));
    return new Response('', { status: 404 });
  });
  const source = createCatalogSource({ url: indexUrl, fetch: fetcher });
  const registry = new AssetRegistry({} as never);
  registry.configurePackIndex(indexUrl);
  registry.setCatalogSource(source, fetcher);
  try {
    for (const guid of guids) {
      const loaded = await registry.loadByGuid(registry.parseGuid(guid));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      expect(loaded.value.kind).toBe('sampler');
    }
    const catalog = (await source.enumerate()).unwrap();
    expect(catalog.map((row) => row.publication)).toEqual(rows.map((row) => row.publication));
    expect(fetcher.mock.calls.filter(([url]) => String(url) === packageUrl)).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
  }
});

it('returns the existing structured Catalog error for a broken publication reference', () => {
  const wire = encodeCatalogWire(rows);
  if (Array.isArray(wire)) throw new Error('expected repeated complete publications');
  const corrupt = JSON.parse(JSON.stringify(wire));
  corrupt.entries[0].publicationIndex = corrupt.publications.length;
  const result = parseCatalog(corrupt);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
});

it('keeps malformed scoped authority rejected before compact admission', () => {
  const wire = encodeCatalogWire(rows);
  const result = parseCatalog(wire, undefined, undefined, { scopeId: 'active', generation: 1 });
  expect(result.ok).toBe(false);
  expect(
    decodeCatalogWire(wire)
      .unwrap()
      .map((row) => row.guid),
  ).toEqual(guids);
});
