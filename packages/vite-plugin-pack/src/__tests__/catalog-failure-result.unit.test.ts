import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCatalog, buildCatalogResult } from '../build-catalog.js';

const roots: string[] = [];
const GOOD_GUID = '018e7a4d-1234-7abc-8def-000000000010';
const BAD_GUID = '018e7a4d-1234-7abc-8def-000000000011';

const meta = (importer: string, kind: string, guid = GOOD_GUID) => ({
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer,
  source: 'asset.bin',
  importSettings: {},
  subAssets: [{ guid, sourceIndex: 0, kind, sourceKey: 'output/main' }],
});

const pack = (guid: string) => ({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [{ guid, kind: 'host/blob', payload: {}, refs: [] }],
});

async function makeRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `forgeax-catalog-failure-${name}-`));
  roots.push(root);
  return root;
}

async function writeMeta(root: string, value: unknown, name = 'asset.bin.meta.json') {
  await writeFile(join(root, 'asset.bin'), Buffer.from('fixture'));
  await writeFile(join(root, name), JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('catalog failure result', () => {
  it('returns a structured conflict for a registered provider using an engine kind', async () => {
    const root = await makeRoot('kind-conflict');
    await writeMeta(root, meta('host-provider', 'texture'));

    const result = await buildCatalogResult([root], '/', new Set(['host-provider']));

    expect(result.authority).toBe('degraded');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'catalog-host-kind-conflict',
        path: join(root, 'asset.bin.meta.json'),
        expected: expect.any(String),
        actual: 'texture',
        hint: expect.any(String),
        subjects: [join(root, 'asset.bin.meta.json')],
      },
    ]);
  });

  it('returns a structured conflict for an unregistered provider', async () => {
    const root = await makeRoot('unregistered');
    await writeMeta(root, meta('missing-provider', 'host/blob'));

    const result = await buildCatalogResult([root]);

    expect(result.authority).toBe('degraded');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'catalog-raw-source-unsupported',
      expected: expect.any(String),
      actual: 'missing-provider',
      hint: expect.any(String),
    });
  });

  it('marks schema or scan failure as degraded with an affected root', async () => {
    const root = await makeRoot('schema-failure');
    await writeMeta(root, { ...meta('gltf', 'mesh'), importSettings: 'invalid' });

    const result = await buildCatalogResult([root]);

    expect(result.authority).toBe('degraded');
    expect(result.diagnostics).toMatchObject([
      {
        code: 'catalog-scan-failed',
        path: root,
        subjects: [root],
        expected: expect.any(String),
        actual: expect.any(String),
        hint: expect.any(String),
      },
    ]);
  });

  it('keeps unaffected roots visible only in an explicitly degraded result', async () => {
    const goodRoot = await makeRoot('partial-good');
    const badRoot = await makeRoot('partial-bad');
    await writeFile(join(goodRoot, 'good.pack.json'), JSON.stringify(pack(GOOD_GUID)));
    await writeFile(join(badRoot, 'first.pack.json'), JSON.stringify(pack(BAD_GUID)));
    await writeFile(join(badRoot, 'second.pack.json'), JSON.stringify(pack(BAD_GUID)));

    const result = await buildCatalogResult([goodRoot, badRoot]);

    expect(result.authority).toBe('degraded');
    expect(result.entries.map((entry) => entry.guid)).toEqual([GOOD_GUID]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.path === badRoot)).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.subjects?.includes(badRoot))).toBe(
      true,
    );
    expect(await buildCatalog([goodRoot, badRoot])).toEqual([]);
  });
});
