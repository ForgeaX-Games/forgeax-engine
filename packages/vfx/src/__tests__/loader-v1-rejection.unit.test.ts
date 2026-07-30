import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { particleEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const PROGRAM_ARTIFACT = 'particle-effect/program.json';

function context(): LoadContext {
  return {
    fetchBinary: async () => {
      throw new Error('asset-local loaders must not fetch legacy global artifacts');
    },
    resolveRef: async () => ({ ok: true, value: 0 }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

function input(
  payload: Record<string, unknown>,
  artifacts: Record<
    string,
    { descriptor: { path: string; mediaType: string }; bytes: Uint8Array }
  > = {},
) {
  return {
    guid: EFFECT_GUID,
    kind: 'particle-effect',
    payload,
    refs: [],
    artifacts,
  };
}

const validPayload = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 32 }],
};

describe('particleEffectPackLoader v2 boundary', () => {
  it('rejects a v1 package-global artifact shape', async () => {
    const result = await particleEffectPackLoader.load(
      input(validPayload, {
        'effect/program.json': {
          descriptor: { path: 'program.json', mediaType: 'application/json' },
          bytes: new TextEncoder().encode('{}'),
        },
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (
      !result.ok &&
      result.error.code === 'vfx-asset-load-failed' &&
      result.error.detail.stage === 'artifact'
    ) {
      expect(result.error.detail.stage).toBe('artifact');
      expect(result.error.detail.artifact).toBe(PROGRAM_ARTIFACT);
    }
  });

  it('rejects raw source fallback when the cooked program is absent', async () => {
    const result = await particleEffectPackLoader.load(
      input({ ...validPayload, source: { emitters: [] }, sourcePath: 'effect.vfx.json' }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (
      !result.ok &&
      result.error.code === 'vfx-asset-load-failed' &&
      result.error.detail.stage === 'artifact'
    ) {
      expect(result.error.detail.stage).toBe('artifact');
      expect(result.error.detail.cause.code).toBe('vfx-artifact-missing');
    }
  });
});
