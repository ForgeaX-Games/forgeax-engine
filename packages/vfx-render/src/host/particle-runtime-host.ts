import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { err, FixedUpdate, ok, type World } from '@forgeax/engine-ecs';
import {
  createStockParticleCpuExecutorRegistry,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  type ParticleSimulation,
  particleEffectPackLoader,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import type {
  ParticleRenderFeature,
  ParticleRenderFeatureOptions,
} from '../feature/particle-render-feature.js';
import { particleRenderFeature } from '../feature/prepared-state.js';
import { particleSceneSpaceResolver } from '../scene/particle-scene-space.js';
import {
  type ParticleRuntimeHostAttachResult,
  type ParticleRuntimeHostDetachResult,
  type ParticleRuntimeHostError,
  type ParticleRuntimeHostResult,
  particleRuntimeHostError,
} from './particle-runtime-readiness.js';

const PARTICLE_SYSTEM_NAME = 'vfx-particle-simulation';

export interface ParticleRuntimeHostOptions {
  readonly camera: ParticleRenderFeatureOptions['camera'];
}

export interface ParticleRuntimeWorldInput {
  readonly world: World;
  readonly assets: AssetRegistry;
}

export interface ParticleRuntimeHost {
  readonly feature: ParticleRenderFeature;
  attachWorld(
    input: ParticleRuntimeWorldInput,
  ): Promise<ParticleRuntimeHostResult<ParticleRuntimeHostAttachResult>>;
  detachWorld(
    input: Pick<ParticleRuntimeWorldInput, 'world'>,
  ): ParticleRuntimeHostResult<ParticleRuntimeHostDetachResult>;
}

interface ParticleWorldBinding {
  readonly simulation: ParticleSimulation;
}

function ensureParticleLoader(
  registry: AssetRegistry,
  registeredRegistries: WeakSet<AssetRegistry>,
): ParticleRuntimeHostError | undefined {
  if (registeredRegistries.has(registry)) return undefined;
  try {
    registry.loaders.registerPackLoader(particleEffectPackLoader);
    registeredRegistries.add(registry);
    return undefined;
  } catch (cause) {
    return particleRuntimeHostError('particle-runtime-loader-install-failed', cause);
  }
}

export function createParticleRuntimeHost(
  options: ParticleRuntimeHostOptions,
): ParticleRuntimeHost {
  const registeredRegistries = new WeakSet<AssetRegistry>();
  const worldBindings = new WeakMap<World, ParticleWorldBinding>();
  const feature = particleRenderFeature({
    observations: {
      read: (world) => {
        if (!world.hasResource(PARTICLE_SIMULATION_RESOURCE_KEY)) return [];
        return world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY).readAll();
      },
    },
    camera: options.camera,
  });

  return {
    feature,
    attachWorld: async (input) => {
      if (worldBindings.has(input.world)) return ok({ state: 'already-attached' });

      const loaderError = ensureParticleLoader(input.assets, registeredRegistries);
      if (loaderError !== undefined) return err(loaderError);

      const plugin = particleSimulationPlugin({
        assets: { lookup: (guid) => input.assets.lookup(guid) },
        cpuExecutors: createStockParticleCpuExecutorRegistry(),
        spaceResolver: particleSceneSpaceResolver({ world: input.world }),
      });
      const built = await plugin.build(input.world);
      if (!built.ok) {
        return err(particleRuntimeHostError('particle-runtime-plugin-build-failed', built.error));
      }
      const simulation = input.world.getResource<ParticleSimulation>(
        PARTICLE_SIMULATION_RESOURCE_KEY,
      );
      worldBindings.set(input.world, { simulation });
      return ok({ state: 'attached' });
    },
    detachWorld: (input) => {
      if (!worldBindings.has(input.world)) return ok({ state: 'not-attached' });
      const removed = input.world.removeSystem(FixedUpdate, PARTICLE_SYSTEM_NAME);
      if (!removed.ok) {
        return err(particleRuntimeHostError('particle-runtime-world-detach-failed', removed.error));
      }
      input.world.removeResource(PARTICLE_SIMULATION_RESOURCE_KEY);
      worldBindings.delete(input.world);
      return ok({ state: 'detached' });
    },
  };
}

export type ParticleRuntimeHostFailure = ParticleRuntimeHostError;
