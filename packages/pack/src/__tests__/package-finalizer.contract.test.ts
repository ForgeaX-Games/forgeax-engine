import { describe, expect, it } from 'vitest';
import {
  finalizePackageProduct,
  type PackageProduct,
  packageTransportRevision,
  upgradeLegacyAuthoredPack,
} from '../package-finalizer.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

function product(overrides: Partial<PackageProduct> = {}): PackageProduct {
  return {
    assets: [
      {
        guid: GUID,
        kind: 'texture',
        payload: { kind: 'texture', width: 1, height: 1 },
        refs: [],
        artifacts: {
          source: { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
        },
      },
    ],
    receipts: [
      {
        guid: GUID,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'sha256:source',
      },
    ],
    diagnostics: [],
    sourceRevision: 'sha256:source',
    sourceKey: 'texture/source',
    ...overrides,
  };
}

describe('engine-pack terminal product and finalizer contract', () => {
  it('upgrades legacy material payloads at the Pack v1 transport boundary', () => {
    const upgraded = upgradeLegacyAuthoredPack({
      schemaVersion: '1.0.0',
      assets: [
        {
          guid: GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                shader: 'forgeax::default-unlit',
                tags: { LightMode: 'Forward' },
                queue: 2000,
              },
            ],
            paramValues: { baseColor: [0.6, 0.6, 0.6, 1] },
          },
        },
      ],
    });

    expect(upgraded).toMatchObject({
      schemaVersion: '2.0.0',
      assets: [
        {
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                program: { module: 'forgeax::default-unlit' },
                renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
              },
            ],
            values: { baseColor: [0.6, 0.6, 0.6, 1] },
          },
        },
      ],
    });
    const materialPayload = upgraded.assets?.[0]?.payload as {
      readonly passes?: readonly Record<string, unknown>[];
    };
    expect(upgraded.assets?.[0]?.payload).not.toHaveProperty('paramValues');
    expect(materialPayload.passes?.[0]).not.toHaveProperty('shader');
    expect(materialPayload.passes?.[0]).not.toHaveProperty('tags');
    expect(materialPayload.passes?.[0]).not.toHaveProperty('queue');
  });

  it('finalizes one complete product with source identity and receipts', async () => {
    const result = await finalizePackageProduct(product(), {
      base: '/assets',
      packagePath: 'packages/texture.pack.json',
      artifactPath: (guid, key) => `artifacts/${guid}/${key}.bin`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pack.assets).toHaveLength(1);
    expect(result.value.digest).toMatch(/^sha256:/);
    expect(result.value.receipts).toHaveLength(1);
    expect(result.value.sourceRevision).toBe('sha256:source');
    expect(result.value.sourceKey).toBe('texture/source');
  });

  it('fails closed on duplicate GUIDs and incomplete receipt evidence', async () => {
    const firstAsset = product().assets[0];
    if (firstAsset === undefined) throw new Error('test product asset is missing');
    const duplicate = product({ assets: [firstAsset, firstAsset] });
    const duplicateResult = await finalizePackageProduct(duplicate, {
      base: '/',
      packagePath: 'packages/duplicate.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    });
    expect(duplicateResult.ok).toBe(false);

    const missingReceipt = product({ receipts: [] });
    const missingReceiptResult = await finalizePackageProduct(missingReceipt, {
      base: '/',
      packagePath: 'packages/missing-receipt.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    });
    expect(missingReceiptResult.ok).toBe(false);
  });

  it('hashes and transports large artifact bodies without JSON-expanding the bytes', async () => {
    const body = new Uint8Array(4 * 1024 * 1024);
    const artifact = { mediaType: 'application/octet-stream', bytes: body };
    const asset = product().assets[0];
    if (asset === undefined) throw new Error('test product asset is missing');
    const large = product({
      assets: [{ ...asset, artifacts: { body: artifact } }],
    });

    const revision = packageTransportRevision(large);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);

    const writes = new Map<string, Uint8Array>();
    const result = await finalizePackageProduct(large, {
      base: '/',
      packagePath: 'large.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
      sink: (path, bytes) => {
        writes.set(path, bytes);
      },
    });
    expect(result.ok).toBe(true);
    const packageBytes = writes.get('large.pack.json');
    expect(packageBytes).toBeDefined();
    const published = JSON.parse(new TextDecoder().decode(packageBytes)) as {
      assets: readonly [{ artifacts: { body: { byteLength: number } } }];
    };
    expect(published.assets[0]?.artifacts.body.byteLength).toBe(body.byteLength);
    expect(writes.get(`${GUID}/body.bin`)).toBe(body);
  });
});
