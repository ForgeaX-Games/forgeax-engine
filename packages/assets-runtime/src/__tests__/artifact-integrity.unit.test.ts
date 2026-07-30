import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { readArtifact } from '../registry/artifact-io';

const GUID = '22222222-2222-4222-8222-222222222222';

describe('artifact integrity and outer encoding', () => {
  it('checks byte length and integrity after outer decoding', async () => {
    const descriptor: ArtifactDescriptor = {
      path: 'payload.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'identity',
      byteLength: 3,
      integrity: {
        algorithm: 'sha256',
        digest: 'sha256-of-decoded-bytes',
      },
    };
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'payload',
        descriptor,
      },
      vi.fn().mockResolvedValue(new Response(Uint8Array.of(1, 2, 3))),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-artifact-integrity-mismatch');
      expect(result.error.expected).toContain('sha256');
      expect(result.error.detail.observed).toBeTruthy();
    }
  });

  it('does not pass asset codec names to the outer decoder', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.of(7, 8)));
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'texture',
        descriptor: {
          path: 'texture.data',
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', profile: 'etc1s' },
          contentEncoding: 'identity',
        },
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, value: Uint8Array.of(7, 8) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
