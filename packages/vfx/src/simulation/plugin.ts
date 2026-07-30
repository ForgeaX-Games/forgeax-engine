import { Entity, type EntityHandle, FixedUpdate, ok, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { toShared } from '@forgeax/engine-types';
import { ParticleEffectPlayer } from '../player.js';
import type { ParticleCpuExecutorRegistry } from './cpu-executor-registry.js';
import { PARTICLE_SIMULATION_RESOURCE_KEY, ParticleSimulation } from './resource.js';
import type { ParticleSimulationAssets, ParticleSimulationPlayerInput } from './types.js';

export interface ParticleSimulationPluginOptions {
  readonly assets: ParticleSimulationAssets;
  readonly cpuExecutors: ParticleCpuExecutorRegistry;
}

/** Build the CPU-only VFX simulation capability for one World. */
export function particleSimulationPlugin(options: ParticleSimulationPluginOptions): Plugin {
  return {
    name: 'vfx-particle-simulation',
    build(world: World) {
      const simulation = new ParticleSimulation(options.assets, options.cpuExecutors);
      world.insertResource(PARTICLE_SIMULATION_RESOURCE_KEY, simulation);
      world
        .addSystem(FixedUpdate, {
          name: 'vfx-particle-simulation',
          queries: [{ with: [Entity, ParticleEffectPlayer] }],
          fn: (_world, queryResults) => {
            const players: ParticleSimulationPlayerInput[] = [];
            for (const bundle of queryResults[0]) {
              const entities = bundle.Entity.self;
              const effects = bundle.ParticleEffectPlayer.effect;
              const playing = bundle.ParticleEffectPlayer.playing;
              const seeds = bundle.ParticleEffectPlayer.seed;
              const timeScales = bundle.ParticleEffectPlayer.timeScale;
              for (let index = 0; index < entities.length; index += 1) {
                const player = entities[index];
                const effect = effects.get(index);
                const playingValue = playing[index];
                const seed = seeds[index];
                const timeScale = timeScales[index];
                if (
                  player === undefined ||
                  effect === undefined ||
                  playingValue === undefined ||
                  seed === undefined ||
                  timeScale === undefined
                ) {
                  continue;
                }
                players.push({
                  player: player as EntityHandle,
                  effect: toShared<'ParticleEffectAsset'>(effect),
                  playing: playingValue !== 0,
                  seed,
                  timeScale,
                });
              }
            }
            simulation.advance(_world, players);
          },
        })
        .unwrap();
      return ok(undefined);
    },
  };
}
