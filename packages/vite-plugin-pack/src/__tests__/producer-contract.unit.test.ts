import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalogResult, buildCatalogStrict, projectLegacyCatalog } from '../build-catalog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('producer-owned catalog contract', () => {
  it('publishes package, provenance, revision, relations, diagnostics, and topology key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-producer-'));
    roots.push(root);
    const guid = '01890000-0000-7000-8000-aaaaaaaaaaaa';
    const dep = '01890000-0000-7000-8000-bbbbbbbbbbbb';
    await writeFile(
      join(root, 'materials.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/materials',
        provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
        revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
        diagnostics: [
          { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
        ],
        assets: [
          {
            guid,
            kind: 'material',
            sourceKey: 'material/main',
            payload: {},
            refs: [dep],
          },
        ],
      }),
    );

    const result = await buildCatalogStrict([root]);
    expect(result.errors).toEqual([]);
    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0]).toMatchObject({
      guid,
      packageId: 'pkg/materials',
      provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
      revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
      sourceKey: 'material/main',
      sourceIndex: 0,
      relations: [
        {
          from: { type: 'asset', id: guid },
          to: { type: 'asset', id: dep },
          type: 'references',
        },
      ],
      diagnostics: [
        { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
      ],
    });
  });

  it('keeps an open host importer neutral without a concrete-kind branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-host-'));
    roots.push(root);
    await writeFile(
      join(root, 'host.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/host',
        provenance: { provider: 'host-fixture', version: '1.0.0' },
        assets: [
          {
            guid: '01890000-0000-7000-8000-cccccccccccc',
            kind: 'host/blob',
            sourceKey: 'blob/main',
            sourceIndex: 0,
            payload: {},
            refs: [],
          },
        ],
      }),
    );
    const result = await buildCatalogStrict([root]);
    expect(result.errors).toEqual([]);
    expect(result.catalog[0]).toMatchObject({ kind: 'host/blob', sourceKey: 'blob/main' });
  });

  it('returns one authoritative result and derives the legacy array from it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-result-'));
    roots.push(root);
    await writeFile(
      join(root, 'result.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/result',
        provenance: { provider: 'result-fixture', version: '1.0.0' },
        revision: { digest: 'sha256:result', observedAt: 7, rootId: 'root-result' },
        assets: [
          {
            guid: '01890000-0000-7000-8000-dddddddddddd',
            kind: 'host/result',
            sourceKey: 'result/main',
            sourceIndex: 0,
            payload: {},
            refs: [],
          },
        ],
      }),
    );

    const result = await buildCatalogResult([root]);
    expect(result).toMatchObject({ authority: 'authoritative', diagnostics: [] });
    expect(result.entries).toHaveLength(1);
    expect(projectLegacyCatalog(result)).toEqual({
      schemaVersion: 'catalog-legacy-v1',
      authority: 'authoritative',
      diagnostics: [],
      entries: result.entries,
    });
    expect(result.entries[0]).toMatchObject({
      packageId: 'pkg/result',
      sourceKey: 'result/main',
      revision: { digest: 'sha256:result', rootId: 'root-result' },
    });
  });

  it('keeps producer identity and revision facts when a locator moves', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-locator-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-locator-b-'));
    roots.push(firstRoot, secondRoot);
    const pack = (source: string) => ({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      packageId: 'pkg/relocated',
      provenance: { provider: 'relocation-fixture', version: '1.0.0' },
      revision: { digest: 'sha256:relocated', observedAt: 8, rootId: 'root-relocated' },
      assets: [
        {
          guid: '01890000-0000-7000-8000-eeeeeeeeeeee',
          kind: 'host/relocated',
          sourceKey: 'relocated/main',
          sourceIndex: 0,
          payload: { source },
          refs: [],
        },
      ],
    });
    await writeFile(join(firstRoot, 'old.pack.json'), JSON.stringify(pack('old')));
    await writeFile(join(secondRoot, 'new.pack.json'), JSON.stringify(pack('new')));

    const [oldResult, newResult] = await Promise.all([
      buildCatalogResult([firstRoot]),
      buildCatalogResult([secondRoot]),
    ]);
    expect(oldResult.entries[0]).toMatchObject({
      packageId: 'pkg/relocated',
      sourceKey: 'relocated/main',
      revision: { digest: 'sha256:relocated' },
    });
    expect(newResult.entries[0]).toMatchObject({
      packageId: 'pkg/relocated',
      sourceKey: 'relocated/main',
      revision: { digest: 'sha256:relocated' },
    });
    expect(newResult.entries[0]?.sourcePath).not.toBe(oldResult.entries[0]?.sourcePath);
  });
});
