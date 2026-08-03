import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import {
  type LoadedParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
  validateParticleRenderBatch,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

function effect(): LoadedParticleEffect {
  const ids = ['first', 'second'];
  return {
    kind: 'particle-effect',
    schemaVersion: 1,
    emitters: ids.map((id) => ({ id, capacity: 2 })),
    program: {
      format: 'forgeax-vfx-program-1',
      emitters: ids.map((id) => ({
        id,
        capacity: 2,
        space: 'world' as const,
        schedule: { rate: 10, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required' as const, backend: 'cpu' as const },
        backendPlan: { kind: 'cpu' as const, backends: ['cpu' as const] },
        operators: { spawn: [], initialize: [], update: [], output: [] },
        output: { kind: 'billboard' as const, material: `${id}-material` },
        programs: { cpu: [] },
      })),
    },
  };
}

describe('particle simulation batches', () => {
  it('publishes validated emitter-order snapshots and legal empty output', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const effectHandle = world.allocSharedRef('ParticleEffectAsset', effect());
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: effectHandle, playing: true, seed: 3, timeScale: 1 },
      })
      .unwrap();
    const plugins = await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: (guid: string) => ({ kind: 'material', guid }) },
          cpuExecutors: new ParticleCpuExecutorRegistry(),
        }),
      ],
    );
    expect(plugins.ok).toBe(true);
    world.update(0.1).unwrap();

    const observation = world
      .getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY)
      .read(player);
    expect(observation?.batches.batches.map((batch) => batch.kind)).toEqual([
      'billboard',
      'billboard',
    ]);
    expect(observation?.emitters.map((emitter) => emitter.emitterId)).toEqual(['first', 'second']);
    expect(validateParticleRenderBatch(observation?.batches).ok).toBe(true);
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const committed = observation;

    world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)).toBe(committed);
    expect(simulation.read(player)?.batches).toBe(committed?.batches);
  });
});
