import type { LoadContext, ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { particleEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const MATERIAL_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const PROGRAM_ARTIFACT = 'particle-effect/program.json';

const asset: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 32 }],
};

function artifactBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function canonicalProgram() {
  return {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'spark',
        capacity: 32,
        space: 'world',
        schedule: { rate: 4, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        backendPlan: { kind: 'cpu', backends: ['cpu'] },
        operators: {
          spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 4 } }],
          initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
          update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
          output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
        },
        output: { kind: 'billboard', material: 'material-spark' },
        programs: {
          cpu: [
            { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate: 4 } },
            { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 1 } },
            { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
            { operator: 'output:billboard:1', program: { opcode: 'billboard', size: 0.25 } },
          ],
        },
      },
    ],
  };
}

function input(
  overrides: Partial<{
    payload: Record<string, unknown>;
    refs: readonly string[];
    artifacts: Record<
      string,
      { descriptor: { path: string; mediaType: string }; bytes: Uint8Array }
    >;
  }> = {},
) {
  return {
    guid: EFFECT_GUID,
    kind: 'particle-effect',
    payload: asset as unknown as Record<string, unknown>,
    refs: [MATERIAL_GUID],
    artifacts: {
      [PROGRAM_ARTIFACT]: {
        descriptor: { path: 'artifacts/program.json', mediaType: 'application/json' },
        bytes: artifactBytes(canonicalProgram()),
      },
    },
    ...overrides,
  };
}

function context(
  refResult: Awaited<ReturnType<LoadContext['resolveRef']>> = {
    ok: true,
    value: 17,
  },
): LoadContext {
  return {
    fetchBinary: async () => ({ ok: true, value: new Uint8Array() }),
    resolveRef: async () => refResult,
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

describe('particleEffectPackLoader', () => {
  it('parses the asset-local program while the Registry owns declared refs', async () => {
    const resolveRef = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'asset-not-found',
        expected: 'referenced material to be ready',
        hint: 'load the material by GUID and retry',
      },
    }));
    const result = await particleEffectPackLoader.load(input(), {
      ...context(),
      resolveRef,
    });

    expect(result).toEqual({ ok: true, value: asset });
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads with a narrow VfxError', async () => {
    const result = await particleEffectPackLoader.load(
      input({ payload: { kind: 'particle-effect', schemaVersion: 2, emitters: [] } }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-asset-load-failed');
      if (result.error.code === 'vfx-asset-load-failed') {
        expect(result.error.detail.stage).toBe('artifact');
        expect(result.error.detail.cause.code).toBe('vfx-payload-invalid');
      }
    }
  });

  it('rejects a cooked payload with no emitters', async () => {
    const result = await particleEffectPackLoader.load(
      input({ payload: { kind: 'particle-effect', schemaVersion: 1, emitters: [] } }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'vfx-asset-load-failed') {
      expect(result.error.detail.cause.code).toBe('vfx-payload-invalid');
    }
  });

  it.each([
    ['zero capacity', [{ id: 'spark', capacity: 0 }]],
    ['negative capacity', [{ id: 'spark', capacity: -1 }]],
    ['NaN capacity', [{ id: 'spark', capacity: Number.NaN }]],
    ['infinite capacity', [{ id: 'spark', capacity: Number.POSITIVE_INFINITY }]],
    ['empty emitter id', [{ id: '', capacity: 32 }]],
    [
      'duplicate emitter id',
      [
        { id: 'spark', capacity: 32 },
        { id: 'spark', capacity: 16 },
      ],
    ],
  ])('rejects %s at the cooked payload boundary', async (_label, emitters) => {
    const result = await particleEffectPackLoader.load(
      input({
        payload: { kind: 'particle-effect', schemaVersion: 1, emitters },
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'vfx-asset-load-failed') {
      expect(result.error.detail.stage).toBe('artifact');
      expect(result.error.detail.cause).toEqual({
        code: 'vfx-payload-invalid',
        expected:
          'every particle emitter to provide a non-empty unique id and finite positive capacity',
        hint: 'recook the particle effect after repairing the emitter payload',
      });
    }
  });

  it('rejects missing or damaged asset-local artifacts', async () => {
    const missing = await particleEffectPackLoader.load(input({ artifacts: {} }), context());
    expect(missing.ok).toBe(false);
    if (
      !missing.ok &&
      missing.error.code === 'vfx-asset-load-failed' &&
      missing.error.detail.stage === 'artifact'
    ) {
      expect(missing.error.detail.stage).toBe('artifact');
      expect(missing.error.detail.artifact).toBe(PROGRAM_ARTIFACT);
    }

    const damaged = await particleEffectPackLoader.load(
      input({
        artifacts: {
          [PROGRAM_ARTIFACT]: {
            descriptor: { path: 'artifacts/program.json', mediaType: 'application/json' },
            bytes: new TextEncoder().encode('{not-json'),
          },
        },
      }),
      context(),
    );
    expect(damaged.ok).toBe(false);
    if (!damaged.ok && damaged.error.code === 'vfx-asset-load-failed') {
      expect(damaged.error.detail.stage).toBe('artifact');
      expect(damaged.error.detail.cause.code).toBe('vfx-program-invalid');
    }
  });

  it('leaves dependency readiness to the AssetRegistry owner', async () => {
    const result = await particleEffectPackLoader.load(
      input(),
      context({
        ok: false,
        error: {
          code: 'asset-not-found',
          expected: 'referenced material to be ready',
          hint: 'load the material by GUID and retry',
        },
      }),
    );

    expect(result).toEqual({ ok: true, value: asset });
  });
});
