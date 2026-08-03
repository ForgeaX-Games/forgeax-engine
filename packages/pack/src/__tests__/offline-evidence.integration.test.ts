import { describe, expect, it } from 'vitest';
import { buildOfflineAssetEvidence } from '../evidence/offline-evidence.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('offline evidence adapter', () => {
  it('joins source inventory, catalog, receipt, and package verification', async () => {
    const result = await buildOfflineAssetEvidence({
      guid,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
      locator: { packageUrl: '/assets/config.pack.json', cookReceiptUrl: '/receipts/config.json' },
      receipt: {
        guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'fp-1',
        outputDigest: 'digest-1',
      },
      package: {
        guid,
        digest: 'digest-1',
        artifacts: {
          data: {
            path: 'artifacts/data.bin',
            mediaType: 'application/octet-stream',
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageUrl).toBe('/assets/config.pack.json');
    expect(result.value.cook.freshness).toBe('current');
    expect(result.value.package?.status).toBe('passed');
  });

  it('keeps runtime and WS outside the offline adapter boundary', () => {
    expect(buildOfflineAssetEvidence.toString()).not.toContain('loadByGuid');
    expect(buildOfflineAssetEvidence.toString()).not.toContain('WebSocket');
  });

  it('projects a verified cook product without requiring DDC storage', async () => {
    const result = await buildOfflineAssetEvidence({
      guid,
      product: {
        guid,
        payload: { kind: 'direct-asset' },
        refs: [],
        artifacts: {
          data: { path: 'assets/data.bin', mediaType: 'application/octet-stream' },
        },
        digest: 'digest-direct',
        receipt: {
          guid,
          origin: 'authoredPack',
          status: 'succeeded',
          inputFingerprint: 'direct-input',
          outputDigest: 'digest-direct',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cook.freshness).toBe('notApplicable');
    expect(result.value.package?.status).toBe('passed');
  });
});
