import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { VfxError } from '../index.js';
import { loadParticleEffect, particleEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const REF_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const PACKAGE_URL = '/effects/pack';

const payload: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 32 }],
};

function recover(error: VfxError): string {
  switch (error.code) {
    case 'vfx-source-invalid':
      return error.detail.path;
    case 'vfx-operator-unknown':
      return error.detail.kind;
    case 'vfx-operator-backend-unsupported':
      return error.detail.backend;
    case 'vfx-program-invalid':
      return error.detail.format;
    case 'vfx-batch-invalid':
      return error.detail.output;
    case 'vfx-asset-load-failed':
      return error.detail.stage;
    case 'vfx-simulation-capability-unavailable':
      return error.detail.backend;
    case 'vfx-simulation-player-invalid':
      return error.detail.field;
    case 'vfx-simulation-output-unavailable':
      return error.detail.reference;
    case 'vfx-simulation-execution-failed':
      return error.detail.operator;
  }
}

function registry(): AssetRegistry {
  const assets = new AssetRegistry({} as never);
  assets.configurePackIndex('/pack-index.json');
  assets.loaders.registerPackLoader(particleEffectPackLoader);
  return assets;
}

function catalogRow(guid: string) {
  return { guid, packageUrl: PACKAGE_URL, kind: 'particle-effect', sourcePath: `${guid}.json` };
}

describe('loadParticleEffect error narrowing', () => {
  it('maps package failures to a package-stage VfxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );

    const result = await loadParticleEffect(registry(), EFFECT_GUID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(recover(result.error)).toBe('package');
      expect(result.error.detail).toMatchObject({
        stage: 'package',
        guid: EFFECT_GUID,
        packageUrl: '/pack-index.json',
        cause: { code: 'asset-not-imported' },
      });
    }
  });

  it('maps asset-local artifact failures and retains the artifact identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(JSON.stringify([catalogRow(EFFECT_GUID)]));
        }
        if (url.endsWith('/effects/pack')) {
          return new Response(
            JSON.stringify({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: EFFECT_GUID,
                  kind: 'particle-effect',
                  payload,
                  refs: [],
                  artifacts: {
                    'particle-effect/program.json': {
                      path: 'spark-program.json',
                      mediaType: 'application/json',
                    },
                  },
                },
              ],
            }),
          );
        }
        return new Response('missing', { status: 404 });
      }),
    );

    const result = await loadParticleEffect(registry(), EFFECT_GUID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(recover(result.error)).toBe('artifact');
      if (
        result.error.code === 'vfx-asset-load-failed' &&
        result.error.detail.stage === 'artifact'
      ) {
        expect(result.error.detail.artifact).toBe('particle-effect/program.json');
        expect(result.error.detail.cause.code).toBe('asset-artifact-missing');
      }
    }
  });

  it('maps a referenced GUID failure without returning the parent asset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(JSON.stringify([catalogRow(EFFECT_GUID), catalogRow(REF_GUID)]));
        }
        if (url.endsWith('root-program.json')) {
          return new Response(
            JSON.stringify({
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
                      {
                        operator: 'spawn:spawn-rate:1',
                        program: { opcode: 'spawn-rate', rate: 4 },
                      },
                      {
                        operator: 'initialize:set-life:1',
                        program: { opcode: 'set-life', seconds: 1 },
                      },
                      { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
                      {
                        operator: 'output:billboard:1',
                        program: { opcode: 'billboard', size: 0.25 },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: EFFECT_GUID,
                kind: 'particle-effect',
                payload,
                refs: [REF_GUID],
                artifacts: {
                  'particle-effect/program.json': {
                    path: 'root-program.json',
                    mediaType: 'application/json',
                  },
                },
              },
            ],
          }),
        );
      }),
    );

    const result = await loadParticleEffect(registry(), EFFECT_GUID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(recover(result.error)).toBe('reference');
      if (
        result.error.code === 'vfx-asset-load-failed' &&
        result.error.detail.stage === 'reference'
      ) {
        expect(result.error.detail.reference).toBe(REF_GUID);
        expect(result.error.detail.cause.code).toBe('asset-not-imported');
      }
    }
  });
});
