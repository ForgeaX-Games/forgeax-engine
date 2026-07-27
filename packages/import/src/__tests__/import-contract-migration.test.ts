import type { Asset, AssetRelation, ImportedAsset, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const DEPENDENCY_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const MESH = {
  kind: 'mesh',
  vertices: new Float32Array(),
  indices: new Uint16Array(),
  attributes: {},
} as unknown as Asset;

const relation: AssetRelation = {
  from: { type: 'asset', id: GUID },
  to: { type: 'asset', id: DEPENDENCY_GUID },
  type: 'references',
  provenance: { provider: 'fixture-producer', version: '2.0.0' },
};

function registry(): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register({
    key: 'fixture',
    import: async (): Promise<ImportResult> => ({
      ok: true,
      value: {
        assets: [
          {
            guid: GUID,
            kind: 'mesh',
            payload: MESH,
            refs: [{ guid: DEPENDENCY_GUID }],
          } satisfies ImportedAsset,
        ],
        artifacts: [],
        sourceDependencies: [],
      },
    }),
  });
  return registry;
}

function readFs() {
  return {
    readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }),
  };
}

function meta(facts: Record<string, unknown> = {}): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'models/fixture.glb',
    ...facts,
    subAssets: [
      {
        guid: GUID,
        sourceKey: 'scene/main',
        sourceIndex: 0,
        kind: 'mesh',
        relations: [relation],
      },
    ],
  } as unknown as RunImportMeta;
}

describe('import runner producer fact propagation', () => {
  it('preserves complete producer facts on the DDC row matched by GUID', async () => {
    const facts = {
      packageId: 'package/fixture',
      provenance: { provider: 'fixture-producer', version: '2.0.0', source: 'fixture.glb' },
      revision: { digest: 'sha256:fixture', observedAt: 42, rootId: 'root-fixture' },
      diagnostics: [
        {
          code: 'fixture-warning',
          severity: 'warning',
          hint: 'reimport the fixture when its source changes',
        },
      ],
    };
    const result = await runImport(meta(facts), registry(), readFs());

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack).toMatchObject(facts);
    expect(result.value.pack.assets).toEqual([
      expect.objectContaining({
        guid: GUID,
        sourceKey: 'scene/main',
        sourceIndex: 0,
        relations: [relation],
      }),
    ]);
  });

  it('keeps optional producer facts absent when the declaration has no evidence', async () => {
    const result = await runImport(meta(), registry(), readFs());

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack).not.toHaveProperty('packageId');
    expect(result.value.pack).not.toHaveProperty('provenance');
    expect(result.value.pack).not.toHaveProperty('revision');
    expect(result.value.pack).not.toHaveProperty('diagnostics');
    expect(result.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      sourceKey: 'scene/main',
      sourceIndex: 0,
      relations: [relation],
    });
  });
});
