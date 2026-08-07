import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { Camera, type Renderer } from '@forgeax/engine-render';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import {
  loadParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleEffectPlayer,
  particleEffectPackLoader,
  particleSimulationPlugin,
  ParticleSimulation,
  createStockParticleCpuExecutorRegistry,
} from '@forgeax/engine-vfx';
import { particleRenderFeature, particleSceneSpaceResolver } from '@forgeax/engine-vfx-render';

/** Source Pack v2 effect owned by the template; the cooker emits its runtime program. */
export const GAME_DEFAULT_HIT_VFX_GUID = '019e9c00-0000-7000-8000-000000000010';
/** A second authored effect that exercises rate scheduling and box spawning. */
export const GAME_DEFAULT_CHARGE_VFX_GUID = '019e9c00-0000-7000-8000-000000000020';

export type VfxHitLoopMode = 'hit' | 'charge';

export interface VfxHitLoopSnapshot {
  readonly available: boolean;
  readonly mode: VfxHitLoopMode;
  readonly playing: boolean;
  readonly seed: number;
  readonly triggers: number;
  readonly guid: string | null;
  readonly emitterCount: number;
  readonly emitterStatuses: readonly string[];
  readonly batchKinds: readonly string[];
  readonly alive: number;
  readonly bucketCount: number;
  readonly readiness: string;
  readonly errorCode: string | null;
  readonly errorHint: string | null;
}

export interface VfxHitLoop {
  readonly trigger: () => void;
  readonly beginCharge: () => void;
  readonly endCharge: () => void;
  readonly triggerCharge: () => void;
  readonly reset: () => void;
  readonly snapshot: () => VfxHitLoopSnapshot;
  readonly dispose: () => void;
}

function unavailable(errorCode: string | null, errorHint: string | null): VfxHitLoopSnapshot {
  return {
    available: false,
    mode: 'hit',
    playing: false,
    seed: 0,
    triggers: 0,
    guid: null,
    emitterCount: 0,
    emitterStatuses: [],
    batchKinds: [],
    alive: 0,
    bucketCount: 0,
    readiness: 'unavailable',
    errorCode,
    errorHint,
  };
}

function cameraSource(camera: EntityHandle) {
  return {
    read(currentWorld: World) {
      const transform = currentWorld.get(camera, Transform);
      const cameraValue = currentWorld.get(camera, Camera);
      if (!transform.ok || !cameraValue.ok) return undefined;
      const position = new Float32Array(transform.value.pos);
      const rotation = transform.value.quat;
      const right = quat.right(vec3.create(), rotation);
      const up = quat.up(vec3.create(), rotation);
      const forward = quat.forward(vec3.create(), rotation);
      const target = vec3.create();
      vec3.add(target, position, forward);
      let viewProjection: Float32Array;
      if (cameraValue.value.projection === 1) {
        const halfWidth = (cameraValue.value.right - cameraValue.value.left) * 0.5;
        const halfHeight = (cameraValue.value.top - cameraValue.value.bottom) * 0.5;
        const projection = mat4.orthographic(
          mat4.create(),
          -halfWidth,
          halfWidth,
          -halfHeight,
          halfHeight,
          cameraValue.value.near,
          cameraValue.value.far,
        );
        const view = mat4.lookAt(mat4.create(), position, target, up);
        viewProjection = mat4.multiply(mat4.create(), projection, view);
      } else {
        viewProjection = mat4.computeViewProj(
          mat4.create(),
          position,
          target,
          up,
          cameraValue.value.fov,
          cameraValue.value.aspect,
          cameraValue.value.near,
          cameraValue.value.far,
        );
      }
      return { position, right, up, viewProjection };
    },
  };
}

/**
 * Attach one replayable transient effect to the existing scored target.
 *
 * The helper deliberately assembles the VFX plugin after the host renderer has
 * been created. This keeps the template's Pack/GUID consumer small while
 * exercising the public late RenderFeature install seam used by asset-driven
 * features that are discovered during bootstrap.
 */
export async function createVfxHitLoop(options: {
  readonly world: World;
  readonly assets?: AssetRegistry;
  readonly renderer?: Renderer;
  readonly target?: EntityHandle;
  readonly camera: EntityHandle;
}): Promise<VfxHitLoop> {
  const { world, assets, renderer, target, camera } = options;
  if (assets === undefined || renderer === undefined || target === undefined) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable('host-unavailable', 'VFX needs the Preview AssetRegistry, Renderer, and a scored target.'), dispose: () => undefined };
  }
  const parsed = AssetGuid.parse(GAME_DEFAULT_HIT_VFX_GUID);
  if (!parsed.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(parsed.error.code, parsed.error.hint), dispose: () => undefined };
  }
  const parsedCharge = AssetGuid.parse(GAME_DEFAULT_CHARGE_VFX_GUID);
  if (!parsedCharge.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(parsedCharge.error.code, parsedCharge.error.hint), dispose: () => undefined };
  }
  assets.loaders.registerPackLoader(particleEffectPackLoader);
  const loaded = await loadParticleEffect(assets, GAME_DEFAULT_HIT_VFX_GUID);
  if (!loaded.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(loaded.error.code, loaded.error.hint), dispose: () => undefined };
  }
  const loadedCharge = await loadParticleEffect(assets, GAME_DEFAULT_CHARGE_VFX_GUID);
  if (!loadedCharge.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(loadedCharge.error.code, loadedCharge.error.hint), dispose: () => undefined };
  }

  const hitEffect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  const chargeEffect = world.allocSharedRef('ParticleEffectAsset', loadedCharge.value);
  const player = world.addComponent(target, {
    component: ParticleEffectPlayer,
    data: { effect: hitEffect, playing: false, seed: 0, timeScale: 1 },
  });
  if (!player.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(player.error.code, player.error.hint), dispose: () => undefined };
  }

  const simulationPlugin = particleSimulationPlugin({
    assets,
    cpuExecutors: createStockParticleCpuExecutorRegistry(),
    spaceResolver: particleSceneSpaceResolver({ world, resolveJoint: () => target }),
  });
  const built = await simulationPlugin.build(world);
  if (!built.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(built.error.code, built.error.hint), dispose: () => undefined };
  }

  const feature = particleRenderFeature({
    observations: {
      read(currentWorld) {
        const simulation = currentWorld.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
        const observation = simulation?.read(target);
        return observation === undefined ? [] : [observation];
      },
    },
    camera: cameraSource(camera),
  });
  const installed = await renderer.installRenderFeature(feature);
  if (!installed.ok) {
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(installed.error.code, installed.error.hint), dispose: () => undefined };
  }

  let seed = 0;
  let mode: VfxHitLoopMode = 'hit';
  let playing = false;
  let triggers = 0;
  let disposed = false;
  const writePlayer = (): void => {
    if (disposed) return;
    world.set(target, ParticleEffectPlayer, { effect: mode === 'hit' ? hitEffect : chargeEffect, playing, seed, timeScale: 1 });
  };
  const snapshot = (): VfxHitLoopSnapshot => {
    const observation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY)?.read(target);
    const diagnostics = feature.diagnostics();
    const error = diagnostics.error;
    return {
      available: true,
      mode,
      playing,
      seed,
      triggers,
      guid: mode === 'hit' ? GAME_DEFAULT_HIT_VFX_GUID : GAME_DEFAULT_CHARGE_VFX_GUID,
      emitterCount: observation?.emitters.length ?? 0,
      emitterStatuses: observation?.emitters.map((emitter) => emitter.status) ?? [],
      batchKinds: observation?.batches.batches.map((batch) => batch.kind) ?? [],
      alive: observation?.telemetry.alive ?? 0,
      bucketCount: diagnostics.bucketCount,
      readiness: diagnostics.readiness,
      errorCode: error?.code ?? null,
      errorHint: error?.hint ?? null,
    };
  };
  return {
    trigger: () => {
      if (disposed) return;
      seed = (seed + 1) >>> 0;
      triggers += 1;
      mode = 'hit';
      playing = true;
      writePlayer();
    },
    beginCharge: () => {
      if (disposed) return;
      if (mode === 'charge' && playing) return;
      seed = (seed + 1) >>> 0;
      triggers += 1;
      mode = 'charge';
      playing = true;
      writePlayer();
    },
    endCharge: () => {
      if (disposed || mode !== 'charge') return;
      playing = false;
      writePlayer();
    },
    triggerCharge: () => {
      if (disposed) return;
      if (mode === 'charge' && playing) return;
      seed = (seed + 1) >>> 0;
      triggers += 1;
      mode = 'charge';
      playing = true;
      writePlayer();
    },
    reset: () => {
      if (disposed) return;
      seed = 0;
      triggers = 0;
      mode = 'hit';
      playing = false;
      writePlayer();
    },
    snapshot,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      playing = false;
      world.set(target, ParticleEffectPlayer, { playing: false });
    },
  };
}
