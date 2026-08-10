import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { err, FixedUpdate, ok, type World } from '@forgeax/engine-ecs';
import type { MaterialAsset, Result } from '@forgeax/engine-types';
import type {
  VfxDataInterfaceError,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
} from '@forgeax/engine-vfx';
import {
  createVfxInspectSnapshot,
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

export interface VfxRuntimeHost {
  readonly feature: ReturnType<typeof gpuParticleRenderFeature>;
  readonly dataInterfaces: VfxDataInterfaceRegistry;
  inspect(world: World): ReturnType<typeof createVfxInspectSnapshot> | undefined;
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

function failure(
  code: VfxRuntimeHostError['code'],
  expected: string,
  hint: string,
  cause: unknown,
): VfxRuntimeHostError {
  return { code, expected, hint, detail: { cause } };
}

export function createVfxRuntimeHost(options: VfxRuntimeHostOptions): VfxRuntimeHost {
  const registries = new WeakSet<AssetRegistry>();
  const worlds = new WeakMap<World, AssetRegistry>();
  const dataInterfaces = createVfxDataInterfaceRegistry(options.providers);
  const feature = gpuParticleRenderFeature({
    camera: options.camera,
    dataInterfaces,
    material: {
      read: (world, guid) => {
        const asset = worlds.get(world)?.lookup(guid);
        return asset?.kind === 'material' ? (asset as MaterialAsset) : undefined;
      },
    },
    mesh: {
      read: (world, guid) => {
        const asset = worlds.get(world)?.lookup(guid);
        return asset?.kind === 'mesh' ? asset : undefined;
      },
    },
  });
  return {
    feature,
    dataInterfaces,
    inspect: (world) => {
      const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
      const intent = runtime.snapshot().at(-1) ?? [...runtime.diagnostics()].at(-1);
      if (intent === undefined || !('emitter' in intent)) return undefined;
      return createVfxInspectSnapshot({
        layoutFingerprint:
          intent.emitter.reflection.layout?.fingerprint ?? intent.programFingerprint,
        parameterGeneration: intent.instanceGeneration,
        patchCount: intent.instancePatchCount,
        channels: runtime.eventCounters(intent.player),
        renderers: { topology: intent.emitter.renderers.map((renderer) => renderer.kind) },
      });
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
      worlds.set(world, assets);
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
