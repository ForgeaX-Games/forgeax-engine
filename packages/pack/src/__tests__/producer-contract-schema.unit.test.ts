import { describe, expect, it } from 'vitest';
import { validateProducerContract } from '../producer-contract.js';
import { validateMeta, validatePack } from '../schema-compiled.js';

const GUID = '01890000-0000-7000-8000-aaaaaaaaaaaa';

function producerFields(): Record<string, unknown> {
  return {
    packageId: 'pkg/fixture',
    provenance: { provider: 'fixture-provider', version: '1.0.0' },
    revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
    diagnostics: [
      {
        code: 'fixture-warning',
        severity: 'warning',
        subject: { type: 'package', id: 'pkg/fixture' },
        expected: 'one stable source key',
        hint: 'declare sourceKey on every imported output',
      },
    ],
  };
}

describe('producer contract schema and semantic validation', () => {
  it('accepts open provider and asset kinds with producer facts', () => {
    const meta = {
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'host-provider',
      ...producerFields(),
      importSettings: {},
      subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'blob/main', kind: 'host/blob' }],
    };
    expect(validateMeta(meta)).toBe(true);
    expect(validateProducerContract(meta).ok).toBe(true);
  });

  it('keeps sourceIndex valid without using it to invent sourceKey', () => {
    const declaration = { guid: GUID, sourceIndex: 0, kind: 'host/blob' };
    const result = validateProducerContract(declaration);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'missing-source-key' }),
    });
  });

  it('accepts structured fields on internal pack assets', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      ...producerFields(),
      assets: [
        {
          guid: GUID,
          kind: 'host/blob',
          sourceKey: 'blob/main',
          sourceIndex: 0,
          payload: {},
          refs: [],
        },
      ],
    };
    expect(validatePack(pack)).toBe(true);
    expect(validateProducerContract(pack.assets[0]).ok).toBe(true);
  });
});
