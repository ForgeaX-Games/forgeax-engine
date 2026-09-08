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
    [
      'raw particle effect source',
      { ...packageRow, packageUrl: '/assets/effects/boss.particle-effect.json' },
    ],
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

  it('preserves producer-owned source override authoring facts', () => {
    const sourceOverrides = {
      'mesh/main': {
        materialSlots: [
          {
            slotName: 'Body',
            sourceKey: 'material/body',
          },
        ],
        materialSlotDefaultOverrides: {
          'material/body': '22222222-2222-4222-8222-222222222222',
        },
      },
    } as const;
    const sourceOverrideDescriptors = [
      { sourceKey: 'mesh/main', payloadSchema: { type: 'object' } },
    ] as const;
    const result = parseCatalog([
      { ...packageRow, sourceKey: 'mesh/main', sourceOverrides, sourceOverrideDescriptors },
    ]);

    expect(result).toEqual({
      ok: true,
      value: new Map([
        [
          packageRow.guid,
          {
            packageUrl: packageRow.packageUrl,
            kind: packageRow.kind,
            sourcePath: packageRow.sourcePath,
            sourceKey: 'mesh/main',
            sourceOverrides,
            sourceOverrideDescriptors,
          },
        ],
      ]),
    });
  });

  it('preserves the complete source publication tuple for runtime fence consumers', () => {
    const publication = {
      schemaVersion: 'asset-publication/1' as const,
      sourcePath: 'assets/showcase.pack.ts',
      sourceRevision: 'sha256:source',
      generation: 3,
      digest: 'sha256:output',
      outputSetDigest: 'sha256:output-set',
      outputs: [
        {
          guid: packageRow.guid,
          sourceKey: 'mesh/main',
          kind: 'mesh',
          digest: 'sha256:mesh',
          refs: [],
        },
      ],
      receipt: {
        schemaVersion: 'asset-publication-receipt/1' as const,
        sourcePath: 'assets/showcase.pack.ts',
        sourceRevision: 'sha256:source',
        inputFingerprint: 'sha256:source',
        outputDigest: 'sha256:output',
        outputSetDigest: 'sha256:output-set',
        externalEvidence: [],
      },
      externalEvidence: [],
      current: {
        generation: 3,
        digest: 'sha256:output',
        outputSetDigest: 'sha256:output-set',
        packageUrl: packageRow.packageUrl,
        receiptKey: 'sha256:source',
      },
    };
    const result = parseCatalog([{ ...packageRow, publication }]);

    expect(result).toEqual({
      ok: true,
      value: new Map([
        [
          packageRow.guid,
          {
            kind: packageRow.kind,
            packageUrl: packageRow.packageUrl,
            sourcePath: packageRow.sourcePath,
            publication,
          },
        ],
      ]),
    });
  });

  it('fetches only the catalog source and preserves package navigation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [packageRow] });
    const source = createCatalogSource({ url: '/preview/pack-index.json', fetch });

    const result = await source.enumerate();

    expect(result).toEqual({ ok: true, value: [packageRow] });
    expect(fetch).toHaveBeenCalledWith('/preview/pack-index.json');
  });
});
