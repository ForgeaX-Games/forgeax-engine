import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { Camera, type Renderer } from '@forgeax/engine-render';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';

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

function failure(error: unknown): { readonly code: string; readonly hint: string } {
  if (error !== null && typeof error === 'object') {
    const value = error as { readonly code?: unknown; readonly hint?: unknown };
    return {
      code: typeof value.code === 'string' ? value.code : 'vfx-host-failed',
      hint: typeof value.hint === 'string' ? value.hint : 'inspect the VFX host failure detail',
    };
  }
  return { code: 'vfx-host-failed', hint: String(error) };
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
  const host = createVfxRuntimeHost({ camera: cameraSource(camera) });
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) {
    const cause = failure(attached.error);
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(cause.code, cause.hint), dispose: () => undefined };
  }
  const loaded = await loadVfxGpuEffect(assets, GAME_DEFAULT_HIT_VFX_GUID);
  if (!loaded.ok) {
    const cause = failure(loaded.error);
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(cause.code, cause.hint), dispose: () => undefined };
  }
  const loadedCharge = await loadVfxGpuEffect(assets, GAME_DEFAULT_CHARGE_VFX_GUID);
  if (!loadedCharge.ok) {
    const cause = failure(loadedCharge.error);
    return { trigger: () => undefined, beginCharge: () => undefined, endCharge: () => undefined, triggerCharge: () => undefined, reset: () => undefined, snapshot: () => unavailable(cause.code, cause.hint), dispose: () => undefined };
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

  const installed = await renderer.installRenderFeature(host.feature);
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
    const runtime = world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)
      ? world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY)
      : undefined;
    const effect: VfxGpuEffectAsset = mode === 'hit' ? loaded.value : loadedCharge.value;
    const diagnostics = runtime?.diagnostics() ?? [];
    const error = diagnostics.at(-1);
    const renderers = effect.program.emitters.flatMap((emitter) =>
      emitter.renderers.map((rendererEntry) => rendererEntry.kind),
    );
    return {
      available: true,
      mode,
      playing,
      seed,
      triggers,
      guid: mode === 'hit' ? GAME_DEFAULT_HIT_VFX_GUID : GAME_DEFAULT_CHARGE_VFX_GUID,
      emitterCount: effect.program.emitters.length,
      emitterStatuses: effect.program.emitters.map(() => 'gpu'),
      batchKinds: renderers,
      alive: 0,
      bucketCount: new Set(renderers).size,
      readiness: runtime?.hasPlayer(target) === true ? 'ready' : 'warming',
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
      host.detachWorld({ world });
    },
  };
}
