import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  type LoadedParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'test-shader' } }],
};

const effect: LoadedParticleEffect = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 1 }],
  program: {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'spark',
        capacity: 1,
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

describe('particle simulation output readiness', () => {
  it('does not publish malformed output and retries ready references', async () => {
    let output: unknown;
    const assets = {
      lookup(guid: string) {
        return guid === 'material-spark' ? output : undefined;
      },
    };
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed: 1, timeScale: 1 } })
      .unwrap();
    const plugins = await runPlugins(
      world,
      [],
      [particleSimulationPlugin({ assets, cpuExecutors: new ParticleCpuExecutorRegistry() })],
    );
    expect(plugins.ok).toBe(true);

    world.update(0.1).unwrap();
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    expect(simulation.read(player)?.batches.batches).toEqual([]);
    expect(simulation.read(player)?.diagnostics[0]?.detail).toMatchObject({
      reference: 'material-spark',
      expectedKind: 'material',
    });

    output = material;
    world.update(0.1).unwrap();
    const batch = simulation.read(player)?.batches.batches[0];
    expect(batch?.kind).toBe('billboard');
    const publishedMaterial = batch?.kind === 'billboard' ? batch.material : undefined;
    if (batch?.kind === 'billboard') {
      expect(world.sharedRefs.resolve(batch.material).ok).toBe(true);
    }

    output = undefined;
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.emitters[0]?.status).toBe('unavailable');
    expect(simulation.read(player)?.batches.batches).toEqual([]);
    expect(simulation.read(player)?.diagnostics[0]?.code).toBe('vfx-simulation-output-unavailable');
    if (publishedMaterial !== undefined) {
      expect(world.sharedRefs.resolve(publishedMaterial).ok).toBe(false);
    }

    output = { kind: 'mesh' };
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.emitters[0]?.status).toBe('unavailable');
    expect(simulation.read(player)?.batches.batches).toEqual([]);

    output = material;
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.emitters[0]?.status).toBe('ready');
    expect(simulation.read(player)?.batches.batches).toHaveLength(1);

    const releasedEffect = world.allocSharedRef('ParticleEffectAsset', effect);
    world.sharedRefs.release(releasedEffect);
    simulation.advance(world, [
      { player, effect: releasedEffect, playing: true, seed: 1, timeScale: 1 },
    ]);
    expect(simulation.read(player)?.effect).toBe(releasedEffect);
    expect(simulation.read(player)?.batches.batches).toEqual([]);
    expect(simulation.read(player)?.diagnostics[0]?.code).toBe('vfx-simulation-player-invalid');
    if (publishedMaterial !== undefined) {
      expect(world.sharedRefs.resolve(publishedMaterial).ok).toBe(false);
    }

    simulation.advance(world, [{ player, effect: handle, playing: true, seed: 1, timeScale: 1 }]);
    expect(simulation.read(player)?.effect).toBe(handle);
    expect(simulation.read(player)?.batches.batches).toHaveLength(1);
  });
});
