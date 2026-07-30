import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import {
  createParticleRenderBatch,
  loadParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleEffectPlayerData,
  type ParticleSimulation,
  particleEffectPackLoader,
  particleSimulationPlugin,
  type VfxError,
  vfxError,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const PACKAGE_URL = '/effects/particle-effects.pack.json';
const PROGRAM_URL = '/effects/program.json';

const cpuExecutors = new ParticleCpuExecutorRegistry([
  {
    stage: 'spawn',
    kind: 'spawn-rate',
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: undefined }),
  },
  {
    stage: 'initialize',
    kind: 'set-life',
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: undefined }),
  },
  {
    stage: 'update',
    kind: 'gravity',
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: undefined }),
  },
  {
    stage: 'output',
    kind: 'billboard',
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: undefined }),
  },
]);

const asset: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 16 }],
};

function registry(): AssetRegistry {
  const shader = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('shader execution is outside this consumer probe');
      },
    },
    manifestUrl: undefined,
  });
  const assets = new AssetRegistry(shader);
  assets.configurePackIndex('/pack-index.json');
  assets.loaders.registerPackLoader(particleEffectPackLoader);
  return assets;
}

function installPackFixture(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    const path = new URL(url, 'http://forgeax.local').pathname;
    if (path === '/pack-index.json') {
      return new Response(
        JSON.stringify([
          {
            guid: EFFECT_GUID,
            packageUrl: PACKAGE_URL,
            kind: 'particle-effect',
            sourcePath: 'spark.particle-effect.json',
          },
        ]),
      );
    }
    if (path === PACKAGE_URL) {
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: EFFECT_GUID,
              kind: 'particle-effect',
              payload: asset,
              refs: [],
              artifacts: {
                'particle-effect/program.json': {
                  path: 'program.json',
                  mediaType: 'application/json',
                },
              },
            },
          ],
        }),
      );
    }
    if (path === PROGRAM_URL) {
      return new Response(
        JSON.stringify({
          format: 'forgeax-vfx-program-1',
          emitters: [
            {
              id: 'spark',
              capacity: 16,
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
                  {
                    operator: 'initialize:set-life:1',
                    program: { opcode: 'set-life', seconds: 1 },
                  },
                  { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
                  { operator: 'output:billboard:1', program: { opcode: 'billboard', size: 0.25 } },
                ],
              },
            },
          ],
        }),
      );
    }
    return new Response('missing', { status: 404 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('fresh public AI consumer VFX path', () => {
  it('discovers a GUID, loads the ready asset, and reaches Player and Batch', async () => {
    const restoreFetch = installPackFixture();
    try {
      const assets = registry();
      const packageGuid = assets.parseGuid(EFFECT_GUID);
      expect(assets.packageOf(packageGuid)?.path).toBeUndefined();

      const loaded = await loadParticleEffect(assets, EFFECT_GUID);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const world = new World();
      const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
      const player: ParticleEffectPlayerData = {
        effect,
        playing: true,
        seed: 7,
        timeScale: 1,
      };
      const spawned = world.spawn({ component: ParticleEffectPlayer, data: player });
      expect(spawned.ok).toBe(true);

      if (!spawned.ok) return;
      const plugins = await runPlugins(
        world,
        [],
        [particleSimulationPlugin({ assets, cpuExecutors })],
      );
      expect(plugins.ok).toBe(true);
      if (!plugins.ok) return;

      expect(world.update(1 / 60).ok).toBe(true);
      const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
      const observation = simulation.read(spawned.value);
      expect(observation?.batches.batches).toEqual([]);
      expect(simulation.replay(spawned.value).ok).toBe(true);

      const batch = createParticleRenderBatch([]);
      expect(batch).toEqual({ ok: true, value: { batches: [] } });
    } finally {
      restoreFetch();
    }
  });

  it('recovers a failed public load through its structured code and hint', async () => {
    const assets = registry();
    const result = await loadParticleEffect(assets, 'not-a-guid');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    switch (result.error.code) {
      case 'vfx-asset-load-failed':
        expect(result.error.hint).toContain('retry');
        break;
      case 'vfx-source-invalid':
      case 'vfx-operator-unknown':
      case 'vfx-operator-backend-unsupported':
      case 'vfx-program-invalid':
      case 'vfx-batch-invalid':
        throw new Error(`unexpected recovery code: ${result.error.code}`);
    }
  });

  it('recovers simulation diagnostics by code and narrowed detail', () => {
    const errors: VfxError[] = [
      vfxError('vfx-simulation-capability-unavailable', {
        player: 7,
        emitterId: 'spark',
        stage: 'spawn',
        backend: 'gpu',
        plan: 'required-gpu',
      }),
      vfxError('vfx-simulation-player-invalid', {
        player: 7,
        field: 'timeScale',
        value: -1,
      }),
      vfxError('vfx-simulation-output-unavailable', {
        player: 7,
        emitterId: 'spark',
        stage: 'output',
        reference: 'material-spark',
        expectedKind: 'material',
      }),
      vfxError('vfx-simulation-execution-failed', {
        player: 7,
        emitterId: 'spark',
        stage: 'update',
        operator: 'update:gravity:1',
        reason: 'executor rejected the cooked program',
      }),
    ];

    const actions = errors.map((error) => {
      switch (error.code) {
        case 'vfx-simulation-capability-unavailable':
          return `${error.detail.backend}:${error.hint}`;
        case 'vfx-simulation-player-invalid':
          return `${error.detail.field}:${error.hint}`;
        case 'vfx-simulation-output-unavailable':
          return `${error.detail.reference}:${error.hint}`;
        case 'vfx-simulation-execution-failed':
          return `${error.detail.operator}:${error.hint}`;
        default:
          return error.hint;
      }
    });

    expect(actions).toEqual([
      expect.stringContaining('gpu:'),
      expect.stringContaining('timeScale:'),
      expect.stringContaining('material-spark:'),
      expect.stringContaining('update:gravity:1:'),
    ]);
    expect(actions.every((action) => !action.includes('message'))).toBe(true);
  });
});
