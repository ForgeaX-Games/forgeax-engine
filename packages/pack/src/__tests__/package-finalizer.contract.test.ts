import { Hash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizePackageProduct,
  finalizePackageTransportSource,
  type PackageProduct,
  packageTransportRevision,
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
  it('shares artifact integrity with transport revision within one finalization', async () => {
    const input = product();
    const body = input.assets[0]?.artifacts.source?.bytes;
    if (body === undefined) throw new Error('missing artifact fixture');
    const policy = {
      base: '/',
      packagePath: 'texture.pack.json',
      artifactPath: (guid: string, key: string) => `${guid}/${key}.bin`,
    };
    const revision = packageTransportRevision(input);
    const expected = await finalizePackageProduct(input, policy);
    if (!expected.ok) throw expected.error;
    const update = vi.spyOn(Hash.prototype, 'update');
    try {
      const finalized = await finalizePackageTransportSource(input, policy);
      expect(finalized.sourceRevision).toBe(revision);
      expect(finalized.pack).toEqual(expected.value.pack);
      expect(finalized.digest).toBe(expected.value.digest);
      // One content hash and one package stream; no second identical content hash.
      expect(update.mock.calls.filter(([data]) => data === body)).toHaveLength(2);
    } finally {
      update.mockRestore();
    }
  });

  it('rehashes mutable artifact subviews on each independent finalization', async () => {
    const storage = new Uint8Array([99, 1, 2, 3, 77]);
    const body = storage.subarray(1, 4);
    const asset = product().assets[0];
    if (asset === undefined) throw new Error('missing asset fixture');
    const input = product({
      assets: [
        {
          ...asset,
          artifacts: {
            body: { mediaType: 'application/octet-stream', bytes: body },
            tail: { mediaType: 'application/octet-stream', bytes: storage.subarray(2, 4) },
          },
        },
      ],
    });
    const policy = {
      base: '/',
      packagePath: 'mesh.pack.json',
      artifactPath: (_guid: string, key: string) => `${key}.bin`,
    };
    const first = await finalizePackageTransportSource(input, policy);
    expect(first.pack.assets[0]?.artifacts.body?.integrity).toBeDefined();
    expect(first.pack.assets[0]?.artifacts.tail?.integrity).toBeDefined();
    storage[0] = 88;
    const outside = await finalizePackageTransportSource(input, policy);
    expect(outside).toEqual(first);
    body[0] = 4;
    const changed = await finalizePackageTransportSource(input, policy);
    expect(changed.sourceRevision).not.toBe(first.sourceRevision);
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.pack.assets[0]?.artifacts.body?.integrity).not.toEqual(
      first.pack.assets[0]?.artifacts.body?.integrity,
    );
    expect(changed.pack.assets[0]?.artifacts.tail?.integrity).toEqual(
      first.pack.assets[0]?.artifacts.tail?.integrity,
    );
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

  it('publishes a mesh LOD relation and keeps the lower mesh in the closure', async () => {
    const lodGuid = '019e3969-1d48-7c3b-ac24-6d68f4570660';
    const root = product().assets[0];
    if (root === undefined) throw new Error('test product asset is missing');
    const result = await finalizePackageProduct(
      product({
        assets: [
          {
            ...root,
            kind: 'mesh',
            payload: {
              kind: 'mesh',
              lods: [{ mesh: lodGuid, screenCoverage: 0.5 }],
            },
            refs: [lodGuid],
          },
          {
            ...root,
            guid: lodGuid,
            kind: 'mesh',
            payload: { kind: 'mesh' },
            refs: [],
          },
        ],
        receipts: [
          {
            guid: GUID,
            origin: 'sourceMeta',
            status: 'succeeded',
            inputFingerprint: 'sha256:source',
          },
          {
            guid: lodGuid,
            origin: 'sourceMeta',
            status: 'succeeded',
            inputFingerprint: 'sha256:source',
          },
        ],
      }),
      {
        base: '/',
        packagePath: 'mesh.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const publishedRoot = result.value.pack.assets.find((asset) => asset.guid === GUID);
    expect(publishedRoot?.refs).toEqual([lodGuid]);
    expect(publishedRoot?.payload).toMatchObject({
      lods: [{ mesh: lodGuid, screenCoverage: 0.5 }],
    });
    expect(result.value.pack.assets.map((asset) => asset.guid)).toContain(lodGuid);
  });
});
