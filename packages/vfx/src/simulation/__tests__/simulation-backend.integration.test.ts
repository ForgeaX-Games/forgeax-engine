import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import {
  type LoadedParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

function effectWithPlans(): LoadedParticleEffect {
  const plans = [
    { id: 'cpu', kind: 'cpu' as const, backends: ['cpu'] as const },
    {
      id: 'fallback',
      kind: 'gpu-with-cpu-fallback' as const,
      backends: ['gpu', 'cpu'] as const,
    },
    { id: 'disabled', kind: 'gpu-or-disable' as const, backends: ['gpu'] as const },
    { id: 'required', kind: 'gpu' as const, backends: ['gpu'] as const },
  ];
  return {
    kind: 'particle-effect',
    schemaVersion: 1,
    emitters: plans.map(({ id }) => ({ id, capacity: 1 })),
    program: {
      format: 'forgeax-vfx-program-1',
      emitters: plans.map(({ id, kind, backends }) => ({
        id,
        capacity: 1,
        space: 'world',
        schedule: { rate: 0, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy:
          kind === 'cpu'
            ? { kind: 'required' as const, backend: 'cpu' as const }
            : kind === 'gpu-or-disable'
              ? {
                  kind: 'preferred' as const,
                  backend: 'gpu' as const,
                  fallback: 'disable' as const,
                }
              : { kind: 'required' as const, backend: 'gpu' as const },
        backendPlan: { kind, backends },
        operators: { spawn: [], initialize: [], update: [], output: [] },
        output: { kind: 'billboard', material: `${id}-material` },
        programs: kind === 'cpu' || kind === 'gpu-with-cpu-fallback' ? { cpu: [] } : {},
      })),
    },
  };
}

describe('particle simulation backend policy', () => {
  it('distinguishes CPU, fallback, disabled, and unavailable states', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const effect = world.allocSharedRef('ParticleEffectAsset', effectWithPlans());
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    const plugins = await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: () => undefined },
          cpuExecutors: new ParticleCpuExecutorRegistry(),
        }),
      ],
    );
    expect(plugins.ok).toBe(true);
    world.update(0.1).unwrap();

    const observation = world
      .getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY)
      .read(player);
    expect(observation?.emitters.map((emitter) => emitter.status)).toEqual([
      'ready',
      'ready',
      'disabled',
      'unavailable',
    ]);
    expect(observation?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'vfx-simulation-capability-unavailable',
    ]);
  });
});
