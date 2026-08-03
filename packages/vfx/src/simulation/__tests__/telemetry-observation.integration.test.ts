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

const effect: LoadedParticleEffect = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 4 }],
  program: {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'spark',
        capacity: 4,
        space: 'world',
        schedule: { rate: 10, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        backendPlan: { kind: 'cpu', backends: ['cpu'] },
        operators: { spawn: [], initialize: [], update: [], output: [] },
        output: { kind: 'billboard', material: 'spark-material' },
        programs: { cpu: [] },
      },
    ],
  },
};

describe('particle simulation telemetry and observations', () => {
  it('derives six telemetry facts from the completed tick', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const effectHandle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: effectHandle, playing: true, seed: 5, timeScale: 1 },
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

    expect(observation?.telemetry).toMatchObject({
      alive: 1,
      spawned: 1,
      dropped: 0,
      selectedBackend: 'cpu',
      allocatedBytes: 0,
    });
    expect(observation?.telemetry.cpuUpdateMs).toBeGreaterThanOrEqual(0);
    expect(observation?.telemetry.tick).toBe(observation?.tick);
  });

  it('keeps the observation and batch view identities stable between completed ticks', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const effectHandle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: effectHandle, playing: true, seed: 6, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: (guid: string) => ({ kind: 'material', guid }) },
          cpuExecutors: new ParticleCpuExecutorRegistry(),
        }),
      ],
    );
    world.update(0.1).unwrap();
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const first = simulation.read(player);
    world.update(0.1).unwrap();
    const second = simulation.read(player);

    expect(second).toBe(first);
    expect(second?.batches).toBe(first?.batches);
    expect(second?.batches.batches[0]?.material).toBe(first?.batches.batches[0]?.material);
  });
});
