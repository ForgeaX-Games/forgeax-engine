import { FixedTime, World } from '@forgeax/engine-ecs';
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
        output: { kind: 'billboard', material: 'material-spark' },
        programs: { cpu: [] },
      },
    ],
  },
};

const cpuExecutors = new ParticleCpuExecutorRegistry();

async function setup() {
  const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
  const handle = world.allocSharedRef('ParticleEffectAsset', effect);
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 7, timeScale: 1 },
    })
    .unwrap();
  const plugins = await runPlugins(
    world,
    [],
    [particleSimulationPlugin({ assets: { lookup: () => undefined }, cpuExecutors })],
  );
  expect(plugins.ok).toBe(true);
  return { world, player };
}

describe('particle simulation lifecycle', () => {
  it('uses FixedTime boundaries for pause, scale validation, replay, and reset', async () => {
    const { world, player } = await setup();
    expect(world.update(0.1).ok).toBe(true);
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const beforePause = simulation.read(player);
    expect(beforePause?.tick).toBe(world.getResource(FixedTime).tick);

    world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.batches).toEqual(beforePause?.batches);

    world.set(player, ParticleEffectPlayer, { timeScale: -1 }).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.diagnostics[0]?.code).toBe('vfx-simulation-player-invalid');

    world.set(player, ParticleEffectPlayer, { timeScale: 1, playing: true }).unwrap();
    simulation.replay(player).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.tick).toBe(world.getResource(FixedTime).tick);
    expect(simulation.reset(player).ok).toBe(true);
  });
});
