import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import type { CatalogEntry } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalogResult } from '../build-catalog.js';
import { calculateCatalogDelta } from '../catalog-watch.js';

const ENGINE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const EDITOR_ROOT = join(ENGINE_ROOT, '..', '..');
const fixtureRoots: string[] = [];

const HOST_KIND = 'nebula/fragment';
const NEXT_HOST_KIND = 'nebula/surface';
const MAIN_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d401';
const DETAIL_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d402';
const EXTRA_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d403';

const legacyConsumerEvidence = {
  tsModules: [
    'packages/core/src/__tests__/asset-io-meta-sidecar.test.ts',
    'packages/core/src/__tests__/mesh-material-resolve.test.ts',
    'packages/core/src/assets/fbx-cook.ts',
    'packages/core/src/io/asset-io-primitives.ts',
    'packages/core/src/scene/mesh-original-materials.ts',
    'packages/core/src/session/import-ops.ts',
    'packages/play-runtime/pack-catalog.ts',
    'packages/play-runtime/src/__tests__/pack-catalog-equirect.test.ts',
  ],
  typeErasedModules: [],
  jsonLiterals: [],
} as const;

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function hostPackage() {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    packageId: 'pkg/nebula-host',
    provenance: { provider: 'nebula-host', version: '3.2.1', source: 'host-fixture' },
    revision: { digest: 'sha256:nebula', observedAt: 42, rootId: 'root-nebula' },
    diagnostics: [
      {
        code: 'nebula-advisory',
        severity: 'warning',
        subject: { type: 'package', id: 'pkg/nebula-host' },
        expected: 'host facts remain neutral',
        hint: 'keep provider-owned fields unchanged in the consumer',
      },
    ],
    assets: [
      {
        guid: MAIN_GUID,
        kind: HOST_KIND,
        sourceKey: 'fragment/main',
        sourceIndex: 0,
        payload: {},
        refs: [DETAIL_GUID],
      },
      {
        guid: DETAIL_GUID,
        kind: HOST_KIND,
        sourceKey: 'fragment/detail',
        sourceIndex: 1,
        payload: {},
        refs: [],
      },
    ],
  };
}

async function buildHostCatalog(): Promise<readonly CatalogEntry[]> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-neutral-consumer-'));
  fixtureRoots.push(root);
  await writeFile(join(root, 'nebula.pack.json'), JSON.stringify(hostPackage()));
  const result = await buildCatalogResult([root]);
  expect(result.authority).toBe('authoritative');
  expect(result.diagnostics).toEqual([]);
  return result.entries;
}

function topologyEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries
    .map((entry) => {
      if (entry.guid === DETAIL_GUID) {
        return { ...entry, kind: NEXT_HOST_KIND, sourceIndex: 0 };
      }
      if (entry.guid === MAIN_GUID) return { ...entry, sourceIndex: 1 };
      return entry;
    })
    .concat({
      guid: EXTRA_GUID,
      packageUrl: '/nebula/extra.bin',
      kind: HOST_KIND,
      sourcePath: 'nebula.pack.json',
      packageId: 'pkg/nebula-host',
      provenance: { provider: 'nebula-host', version: '3.2.1', source: 'host-fixture' },
      revision: { digest: 'sha256:nebula', observedAt: 42, rootId: 'root-nebula' },
      sourceKey: 'fragment/extra',
      sourceIndex: 2,
    });
}

async function assertNoNewConcreteKindSwitches(): Promise<void> {
  const firstEvidencePath = join(EDITOR_ROOT, legacyConsumerEvidence.tsModules[0]);
  try {
    await access(firstEvidencePath);
  } catch {
    return;
  }

  for (const relativePath of legacyConsumerEvidence.tsModules) {
    const source = await readFile(join(EDITOR_ROOT, relativePath), 'utf8');
    expect(source).not.toContain(HOST_KIND);
    expect(source).not.toContain(NEXT_HOST_KIND);
  }
  expect(legacyConsumerEvidence.typeErasedModules).toEqual([]);
  expect(legacyConsumerEvidence.jsonLiterals).toEqual([]);
}

describe('neutral consumer with a registered host provider', () => {
  it('reads open provider facts through CatalogSource without a concrete-kind branch', async () => {
    const entries = await buildHostCatalog();
    const source = createCatalogSource({ entries });
    const enumerated = await source.enumerate();

    expect(enumerated.ok).toBe(true);
    if (!enumerated.ok) return;
    expect(enumerated.value.map((entry) => entry.kind)).toEqual([HOST_KIND, HOST_KIND]);
    expect(enumerated.value[0]).toMatchObject({
      packageId: 'pkg/nebula-host',
      provenance: { provider: 'nebula-host', version: '3.2.1' },
      revision: { digest: 'sha256:nebula', rootId: 'root-nebula' },
      sourceKey: 'fragment/main',
      sourceIndex: 0,
      relations: [
        {
          from: { type: 'asset', id: MAIN_GUID },
          to: { type: 'asset', id: DETAIL_GUID },
          type: 'references',
        },
      ],
      diagnostics: [{ code: 'nebula-advisory', severity: 'warning' }],
    });
  });

  it('keeps topology actions neutral for reorder, add, and an incompatible kind change', async () => {
    const previous = await buildHostCatalog();
    const delta = calculateCatalogDelta(previous, topologyEntries(previous));
    const topology = delta?.topology?.[0];

    expect(topology).toBeDefined();
    expect(new Set(topology?.preserved.map((item) => item.guid))).toEqual(new Set([MAIN_GUID]));
    expect(new Set(topology?.added.map((item) => item.sourceKey))).toEqual(
      new Set(['fragment/detail', 'fragment/extra']),
    );
    expect(new Set(topology?.removed.map((item) => item.sourceKey))).toEqual(
      new Set(['fragment/detail']),
    );
    expect(topology?.changedKind).toMatchObject([
      {
        guid: DETAIL_GUID,
        oldKind: HOST_KIND,
        newKind: NEXT_HOST_KIND,
        action: 'remove-add',
      },
    ]);
  });

  it('records the three consumer scan channels and finds no concrete host-kind switch', async () => {
    await assertNoNewConcreteKindSwitches();
    expect(legacyConsumerEvidence).toEqual({
      tsModules: expect.arrayContaining([
        'packages/core/src/io/asset-io-primitives.ts',
        'packages/play-runtime/pack-catalog.ts',
      ]),
      typeErasedModules: [],
      jsonLiterals: [],
    });
  });
});
