import { createHash } from 'node:crypto';
import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { loadVerifiedTexturePack, type TexturePackLoadInput } from '../loaders/pack-artifact.js';
import {
  createTexturePublicationState,
  type TexturePublicationState,
} from '../registry/validate-material.js';

const GUID = '019ffa97-3000-7000-8000-000000000301';
const SOURCE_KEY = 'density/volume';

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const context: LoadContext = {
  fetchBinary: async () => ({ ok: false as const, error: new Error('not used') }),
  resolveRef: async () => ({ ok: false as const, error: new Error('not used') }),
  transcodeCaps: { bc: false, etc2: false, astc: false },
  device: undefined,
};

function input(
  bytes: Uint8Array,
  overrides: Partial<TexturePackLoadInput> = {},
): TexturePackLoadInput {
  const actualDigest = digest(bytes);
  return {
    sourceKey: SOURCE_KEY,
    generation: 2,
    expectedDigest: actualDigest,
    pack: {
      guid: GUID,
      kind: 'texture',
      payload: {
        shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
        format: 'r8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
      },
      refs: [],
      artifacts: {
        body: {
          bytes,
          descriptor: {
            path: 'density.raw',
            mediaType: 'application/x-forgeax-r8',
            byteLength: 8,
            integrity: { algorithm: 'sha256', digest: actualDigest },
          },
        },
      },
    },
    ...overrides,
  };
}

describe('verified texture Pack loader', () => {
  it('rejects bad byte length with GUID, generation, and loader stage', async () => {
    const result = await loadVerifiedTexturePack(input(new Uint8Array(7)), context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('texture-pack-verification-failed');
      expect(result.error.detail).toMatchObject({
        guid: GUID,
        sourceKey: SOURCE_KEY,
        generation: 2,
        stage: 'loader',
        expectedBytes: 8,
        actualBytes: 7,
      });
    }
  });

  it('rejects digest and canonical order mismatch before exposing an asset', async () => {
    const digestMismatch = await loadVerifiedTexturePack(
      input(new Uint8Array(8), { expectedDigest: 'sha256:not-the-artifact' }),
      context,
    );
    expect(digestMismatch.ok).toBe(false);
    if (!digestMismatch.ok) {
      expect(digestMismatch.error.code).toBe('texture-pack-verification-failed');
      expect(digestMismatch.error.detail).toMatchObject({
        guid: GUID,
        generation: 2,
        stage: 'loader',
        cause: 'digest-mismatch',
      });
    }

    const orderMismatch = await loadVerifiedTexturePack(
      input(new Uint8Array(8), {
        pack: {
          ...input(new Uint8Array(8)).pack,
          payload: {
            ...input(new Uint8Array(8)).pack.payload,
            packingOrder: 'row-major,mip-major,image-major',
          },
        },
      }),
      context,
    );
    expect(orderMismatch.ok).toBe(false);
    if (!orderMismatch.ok) {
      expect(orderMismatch.error.detail).toMatchObject({
        guid: GUID,
        stage: 'loader',
        cause: 'packing-order-mismatch',
      });
    }
  });

  it('advances accepted generation only after a verified candidate succeeds', async () => {
    const state: TexturePublicationState = createTexturePublicationState({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      generation: 1,
      digest: 'sha256:accepted',
    });
    const failed = await loadVerifiedTexturePack(input(new Uint8Array(7)), context);
    expect(failed.ok).toBe(false);
    const afterFailure = state.reject({
      generation: 2,
      reason: 'byte-length',
    });
    expect(afterFailure).toEqual({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      acceptedGeneration: 1,
      acceptedDigest: 'sha256:accepted',
      candidateGeneration: 2,
      candidateFailure: 'byte-length',
    });

    const accepted = state.accept({ generation: 2, digest: 'sha256:repaired' });
    expect(accepted).toEqual({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      acceptedGeneration: 2,
      acceptedDigest: 'sha256:repaired',
    });
  });
});
