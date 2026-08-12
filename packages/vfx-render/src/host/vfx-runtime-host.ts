import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, err, FixedUpdate, ok, type World } from '@forgeax/engine-ecs';
import type { MaterialAsset, Result } from '@forgeax/engine-types';
import type {
  VfxDataInterfaceError,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
  VfxGpuPlayerInspectSnapshot,
  VfxGpuRuntimeDiagnostic,
  VfxReplayInput,
  VfxValueMap,
} from '@forgeax/engine-vfx';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuEffectPackLoader,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import type { ParticleRenderCameraSource } from '../feature/camera.js';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import {
  createVfxDataInterfaceRegistry,
  type VfxDataInterfaceRegistry,
} from './data-interface-providers.js';

export interface VfxRuntimeHostOptions {
  readonly camera: ParticleRenderCameraSource;
  readonly maxQueuedTicks?: number;
  readonly providers?: readonly VfxDataInterfaceProvider[];
}

export interface VfxRuntimeHostError {
  readonly code:
    | 'vfx-host-loader-install-failed'
    | 'vfx-host-world-attach-failed'
    | 'vfx-host-world-detach-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly cause: unknown };
}

export interface VfxRuntimeHostControlError {
  readonly code:
    | 'vfx-host-control-world-detached'
    | 'vfx-host-control-stale-generation'
    | 'vfx-host-control-runtime-unavailable'
    | 'vfx-host-control-player-unavailable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly requestedGeneration?: number;
    readonly currentGeneration?: number;
    readonly player?: EntityHandle;
  };
}

export interface VfxRuntimeHostControl {
  readonly generation: number;
  replay(input: {
    readonly player: EntityHandle;
    readonly replayInput?: VfxReplayInput<VfxValueMap>;
  }): Result<{ readonly state: 'queued'; readonly generation: number }, VfxRuntimeHostControlError>;
  setEmitterSessionEnabled(input: {
    readonly player: EntityHandle;
    readonly emitterId: string;
    readonly enabled: boolean;
  }): Result<
    {
      readonly state: 'enabled' | 'disabled';
      readonly generation: number;
    },
    VfxRuntimeHostControlError
  >;
}

export interface VfxRuntimeHost {
  readonly feature: ReturnType<typeof gpuParticleRenderFeature>;
  readonly dataInterfaces: VfxDataInterfaceRegistry;
  inspect(world: World): VfxRuntimeHostInspectSnapshot | undefined;
  acquireControl(world: World): Result<VfxRuntimeHostControl, VfxRuntimeHostControlError>;
  resolveDataInterfaces(input: {
    readonly requirements: readonly VfxDataInterfaceRequirement[];
    readonly generation: number;
  }): Result<VfxDataInterfaceResolution, VfxDataInterfaceError>;
  attachWorld(input: {
    readonly world: World;
    readonly assets: AssetRegistry;
  }): Promise<Result<{ readonly state: 'attached' | 'already-attached' }, VfxRuntimeHostError>>;
  detachWorld(input: {
    readonly world: World;
  }): Result<{ readonly state: 'detached' | 'not-attached' }, VfxRuntimeHostError>;
}

export interface VfxRuntimeHostInspectSnapshot {
  readonly generation: number;
  readonly players: readonly VfxGpuPlayerInspectSnapshot[];
  readonly diagnostics: readonly VfxGpuRuntimeDiagnostic[];
}

function failure(
  code: VfxRuntimeHostError['code'],
  expected: string,
  hint: string,
  cause: unknown,
): VfxRuntimeHostError {
  return { code, expected, hint, detail: { cause } };
}

function controlFailure(
  code: VfxRuntimeHostControlError['code'],
  expected: string,
  hint: string,
  detail: VfxRuntimeHostControlError['detail'] = {},
): VfxRuntimeHostControlError {
  return { code, expected, hint, detail };
}

export function createVfxRuntimeHost(options: VfxRuntimeHostOptions): VfxRuntimeHost {
  const registries = new WeakSet<AssetRegistry>();
  const worlds = new WeakMap<
    World,
    { readonly assets: AssetRegistry; readonly generation: number }
  >();
  let nextGeneration = 1;
  const dataInterfaces = createVfxDataInterfaceRegistry(options.providers);
  const feature = gpuParticleRenderFeature({
    camera: options.camera,
    dataInterfaces,
    material: {
      read: (world, guid) => {
        const asset = worlds.get(world)?.assets.lookup(guid);
        return asset?.kind === 'material' ? (asset as MaterialAsset) : undefined;
      },
    },
    mesh: {
      read: (world, guid) => {
        const asset = worlds.get(world)?.assets.lookup(guid);
        return asset?.kind === 'mesh' ? asset : undefined;
      },
    },
  });
  return {
    feature,
    dataInterfaces,
    inspect: (world) => {
      const attached = worlds.get(world);
      if (attached === undefined || !world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY))
        return undefined;
      const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
      return Object.freeze({
        generation: attached.generation,
        players: runtime.inspectPlayers(),
        diagnostics: runtime.diagnostics(),
      });
    },
    acquireControl: (world) => {
      const attached = worlds.get(world);
      if (attached === undefined) {
        return err(
          controlFailure(
            'vfx-host-control-world-detached',
            'an attached VFX Runtime World',
            'attach the World to this VfxRuntimeHost before acquiring controls',
          ),
        );
      }
      const requestedGeneration = attached.generation;
      const withRuntime = <T>(
        player: EntityHandle,
        action: (runtime: VfxGpuRuntime) => T,
      ): Result<T, VfxRuntimeHostControlError> => {
        const current = worlds.get(world);
        if (current === undefined) {
          return err(
            controlFailure(
              'vfx-host-control-world-detached',
              `VFX host generation ${requestedGeneration} to remain attached`,
              'reacquire controls after the World is attached again',
              { requestedGeneration },
            ),
          );
        }
        if (current.generation !== requestedGeneration) {
          return err(
            controlFailure(
              'vfx-host-control-stale-generation',
              `VFX host generation ${requestedGeneration}`,
              'discard this stale control lease and acquire one from the current host generation',
              { requestedGeneration, currentGeneration: current.generation },
            ),
          );
        }
        if (!world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) {
          return err(
            controlFailure(
              'vfx-host-control-runtime-unavailable',
              'the attached World to own its VFX GPU runtime resource',
              'repair the host attachment before retrying the preview command',
              { requestedGeneration, currentGeneration: current.generation },
            ),
          );
        }
        if (!world.get(player, ParticleEffectPlayer).ok) {
          return err(
            controlFailure(
              'vfx-host-control-player-unavailable',
              'a live entity with ParticleEffectPlayer in the attached World',
              'discard the stale player handle or target a VFX player owned by this World',
              { requestedGeneration, currentGeneration: current.generation, player },
            ),
          );
        }
        return ok(action(world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY)));
      };
      const control: VfxRuntimeHostControl = {
        generation: requestedGeneration,
        replay: ({ player, replayInput }) =>
          withRuntime(player, (runtime) => {
            runtime.replay(player, replayInput);
            return Object.freeze({ state: 'queued' as const, generation: requestedGeneration });
          }),
        setEmitterSessionEnabled: ({ player, emitterId, enabled }) =>
          withRuntime(player, (runtime) => {
            runtime.setEmitterSessionEnabled(player, emitterId, enabled);
            return Object.freeze({
              state: enabled ? ('enabled' as const) : ('disabled' as const),
              generation: requestedGeneration,
            });
          }),
      };
      return ok(Object.freeze(control));
    },
    resolveDataInterfaces: ({ requirements, generation }) =>
      dataInterfaces.resolve(requirements, generation),
    attachWorld: async ({ world, assets }) => {
      if (worlds.has(world)) return ok({ state: 'already-attached' });
      if (!registries.has(assets)) {
        try {
          assets.loaders.registerPackLoader(vfxGpuEffectPackLoader);
          registries.add(assets);
        } catch (cause) {
          return err(
            failure(
              'vfx-host-loader-install-failed',
              'the v2 VFX loader to be registered once',
              'remove a conflicting particle-effect loader and retry attachWorld',
              cause,
            ),
          );
        }
      }
      const installed = await vfxGpuRuntimePlugin(
        options.maxQueuedTicks === undefined ? {} : { maxQueuedTicks: options.maxQueuedTicks },
      ).build(world);
      if (!installed.ok) {
        return err(
          failure(
            'vfx-host-world-attach-failed',
            'the World FixedUpdate VFX intent producer to install',
            'repair the reported World registration conflict and retry',
            installed.error,
          ),
        );
      }
      worlds.set(world, { assets, generation: nextGeneration++ });
      return ok({ state: 'attached' });
    },
    detachWorld: ({ world }) => {
      if (!worlds.has(world)) return ok({ state: 'not-attached' });
      const removed = world.removeSystem(FixedUpdate, 'vfx-gpu-runtime');
      if (!removed.ok) {
        return err(
          failure(
            'vfx-host-world-detach-failed',
            'the VFX FixedUpdate producer to detach exactly once',
            'inspect the World schedule and retry detachWorld',
            removed.error,
          ),
        );
      }
      world.removeResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
      worlds.delete(world);
      return ok({ state: 'detached' });
    },
  };
}
