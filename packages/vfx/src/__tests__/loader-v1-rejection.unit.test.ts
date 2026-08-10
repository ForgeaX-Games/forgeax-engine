import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { vfxGpuEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
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

describe('vfxGpuEffectPackLoader v2 boundary', () => {
  it('rejects a v1 package-global artifact shape', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input(validPayload, {
        'effect/program.json': {
          descriptor: { path: 'program.json', mediaType: 'application/json' },
          bytes: new TextEncoder().encode('{}'),
        },
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-asset-v2-invalid');
      expect(result.error.detail.path).toBe('payload');
    }
  });

  it('rejects raw source fallback when the cooked program is absent', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input({ ...validPayload, source: { emitters: [] }, sourcePath: 'effect.vfx.json' }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-asset-v2-invalid');
      expect(result.error.detail.path).toBe('payload');
    }
  });
});
