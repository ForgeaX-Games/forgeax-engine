import { type Plugin, type PluginError, runPlugins } from '@forgeax/engine-plugin';
import type { Handle, ParticleEffectAsset, Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleEffectPlayerData,
  type ParticleSimulation,
  type ParticleSimulationAssets,
  type ParticleSimulationObservation,
  particleSimulationPlugin,
} from '../index.js';

declare const world: import('@forgeax/engine-ecs').World;
declare const defaultSet: readonly Plugin[];
declare const assets: ParticleSimulationAssets;

describe('public ParticleSimulation API type applications', () => {
  it('type-checks enable, spawn data, and observation paths from root exports', () => {
    expectTypeOf(publicConsumerTypeCheck).toBeFunction();
  });
});

function publicConsumerTypeCheck(): void {
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 1,
    emitters: [{ id: 'spark', capacity: 1 }],
  };
  const effect: Handle<'ParticleEffectAsset', 'shared'> = world.allocSharedRef(
    'ParticleEffectAsset',
    asset,
  );
  const playerData: ParticleEffectPlayerData = {
    effect,
    playing: true,
    seed: 7,
    timeScale: 1,
  };
  const spawned = world.spawn({ component: ParticleEffectPlayer, data: playerData });
  const plugin = particleSimulationPlugin({
    assets,
    cpuExecutors: new ParticleCpuExecutorRegistry(),
  });
  const enabled = runPlugins(world, defaultSet, [plugin]);

  expectTypeOf(enabled).toEqualTypeOf<Promise<Result<Map<string, Plugin>, PluginError>>>();

  const player = spawned.unwrap();
  const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
  const observation = simulation.read(player);
  const replay = simulation.replay(player);
  expectTypeOf(observation).toEqualTypeOf<ParticleSimulationObservation | undefined>();
  expectTypeOf(replay.ok).toEqualTypeOf<boolean>();
}
