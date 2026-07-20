// @forgeax/engine-runtime - RenderSystem record stage: helpers.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { EquirectAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { EquirectProjectionFailedError } from '../errors/render';
import type { RenderSystemInternals } from '../render-system';
import type { CameraSnapshot, MaterialSnapshot } from '../render-system-extract';
import type { RenderFrameState } from './frame-snapshot';

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for directional
 * N>1 overrun. Fires console.warn at most once per RenderSystem lifetime.
 * Extracted as a pure helper so the warn-once logic is directly testable
 * without a full recordFrame argument list (AC-05 (c)).
 */
export function warnMultiLightDirectional(
  frameState: Pick<RenderFrameState, 'warnedMultiLightDirectional'>,
  directionalCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightDirectional && directionalCount > 1) {
    frameState.warnedMultiLightDirectional = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light directional: at most 1 entity (got N=' +
          directionalCount +
          '). First entity used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 1 directional',
          detail: { type: 'directional', got: directionalCount },
        },
      );
    }
  }
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for point light
 * N>4 overrun (first-slice cap). Fires at most once per RenderSystem
 * lifetime.
 */
export function warnMultiLightPoint(
  frameState: Pick<RenderFrameState, 'warnedMultiLightPoint'>,
  pointCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightPoint && pointCount > 4) {
    frameState.warnedMultiLightPoint = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light point: at most 4 entities (got N=' +
          pointCount +
          '). First 4 used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 4 point',
          detail: { type: 'point', got: pointCount },
        },
      );
    }
  }
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for spot light
 * N>4 overrun (first-slice cap). Fires at most once per RenderSystem
 * lifetime.
 */
export function warnMultiLightSpot(
  frameState: Pick<RenderFrameState, 'warnedMultiLightSpot'>,
  spotCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightSpot && spotCount > 4) {
    frameState.warnedMultiLightSpot = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light spot: at most 4 entities (got N=' +
          spotCount +
          '). First 4 used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 4 spot',
          detail: { type: 'spot', got: spotCount },
        },
      );
    }
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
 * once-warn for >1 Skylight entity (first archetype hit wins). Fires at most
 * once per RenderSystem lifetime and names the WINNING entity handle so the
 * scene author can tell which Skylight is used and that the rest are ignored
 * (F-8: warn carries conflicting entity info; charter P3 explicit failure with
 * a warn-once signal floor, no per-frame flooding).
 */
export function warnMultiSkylight(
  frameState: Pick<RenderFrameState, 'warnedMultiSkylight'>,
  skylightCount: number,
  winningEntityHandle: number,
): void {
  if (!frameState.warnedMultiSkylight && skylightCount > 1) {
    frameState.warnedMultiSkylight = true;
    console.warn(
      `[forgeax] Skylight: ${skylightCount} Skylight entities found; using entity ` +
        `${winningEntityHandle} (first by archetype order) for IBL ambient. The other ` +
        `${skylightCount - 1} Skylight ${skylightCount - 1 === 1 ? 'entity is' : 'entities are'} ignored. ` +
        `Keep a single Skylight per scene, or reorder so the intended one is first.`,
    );
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
 * once-warn for >1 SkyboxBackground entity (mirrors warnMultiSkylight). Names
 * the winning entity handle; fires once per RenderSystem lifetime.
 */
export function warnMultiSkybox(
  frameState: Pick<RenderFrameState, 'warnedMultiSkybox'>,
  skyboxCount: number,
  winningEntityHandle: number,
): void {
  if (!frameState.warnedMultiSkybox && skyboxCount > 1) {
    frameState.warnedMultiSkybox = true;
    console.warn(
      `[forgeax] SkyboxBackground: ${skyboxCount} SkyboxBackground entities found; using ` +
        `entity ${winningEntityHandle} (first by archetype order). The other ` +
        `${skyboxCount - 1} ${skyboxCount - 1 === 1 ? 'entity is' : 'entities are'} ignored. ` +
        `Keep a single SkyboxBackground per scene.`,
    );
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
 * lazy equirect-to-cubemap projection trigger. Driven once per frame from
 * `recordFrame` for the active equirect handle (Skylight's, or the
 * SkyboxBackground's when no Skylight cubemap is present -- both reuse one
 * handle). Implements the plan-strategy D-4 state machine:
 *
 *   undefined (no entry) + caps OK -> resolve POD + fire-and-forget projection
 *                                     (the store writes status:'pending'
 *                                     synchronously, so this launches once)
 *   pending                        -> in flight; bind white fallback (no fire)
 *   ready                          -> bound by recordMainPass's IBL cache check
 *   failed                         -> fire EquirectProjectionFailedError ONCE
 *                                     per handle (R-2/AC-09 no retry)
 *   caps.rgba16floatRenderable
 *     === false                    -> never project; permanent white fallback
 *                                     (AC-06: the only IBL gate, no UA guard)
 *
 * Fire-and-forget: `_uploadCubemapFromEquirect` is invoked WITHOUT await so the
 * record stay synchronous; the store mutates its own status map and (on
 * success) the per-device IblPipelineCache, which recordMainPass reads on a
 * later frame. The structured error from a fire-and-forget failure is reported
 * via the explicit `status === 'failed'` arm here (read on the next frame), not
 * by awaiting the promise (which would block record).
 */
export function driveLazyEquirectProjection(
  internals: RenderSystemInternals,
  world: World,
  frameState: Pick<RenderFrameState, 'firedEquirectProjectionFailedHandles'>,
  equirectHandle: number,
): void {
  const store = internals.gpuStore;
  const handle = toShared<'EquirectAsset'>(equirectHandle);
  const status = store.getCubemapStatus(handle);

  if (status === 'failed') {
    // Fire the structured error exactly once per failed source (the store
    // records failed permanently and never retries; R-2 / AC-09).
    if (!frameState.firedEquirectProjectionFailedHandles.has(equirectHandle)) {
      frameState.firedEquirectProjectionFailedHandles.add(equirectHandle);
      internals.errorRegistry.fire(new EquirectProjectionFailedError(equirectHandle));
    }
    return;
  }

  // 'pending' and 'ready' are both handled downstream (white fallback while
  // pending; real IBL once ready). Only the first sight ('undefined') launches.
  if (status !== undefined) return;

  // caps gate (AC-06): rgba16float must be renderable for the HDR cubemap path.
  // When unavailable, never launch -- the white fallback is permanent. No entry
  // is written, so this re-checks cheaply each frame (a later device with the
  // cap could then project). No UA guard -- caps is the only signal.
  if (internals.device.caps.rgba16floatRenderable === false) return;

  // First sight: resolve the equirect POD and fire-and-forget the projection.
  const podRes = resolveAssetHandle<EquirectAsset>(world, handle);
  if (!podRes.ok || podRes.value.kind !== 'equirect') {
    // The handle does not resolve to a live equirect POD (stale / wrong kind).
    // Launch nothing; the store stays empty and the white fallback holds. The
    // skybox / IBL degradation paths surface the missing resource per their own
    // gates -- this trigger only drives a valid equirect source.
    return;
  }
  // Fire-and-forget: do NOT await. The store writes status:'pending'
  // synchronously (before its first await), so a re-entry next frame
  // short-circuits and this launches exactly once.
  void store._uploadCubemapFromEquirect(world, handle, podRes.value);
}

/**
 * Returns true when a MaterialSnapshot represents a lit (non-unlit) material
 * that will render black with zero lights — i.e. the material has a
 * materialShaderId set and it is NOT the builtin unlit shader.
 *
 * The default mid-grey fallback (materialShaderId === undefined) is excluded
 * — it routes through defaultMaterialSnapshot and never triggers the
 * zero-light warning.
 *
 * @internal — exported so AC-02 zero-light-warning test can anchor to
 * the production implementation rather than a test-local copy.
 */
export function isLitMaterialSnapshot(material: MaterialSnapshot): boolean {
  return (
    material.materialShaderId !== undefined &&
    material.materialShaderId !== 'forgeax::default-unlit'
  );
}

export function computeViewMatrix(camera: CameraSnapshot): Mat4 {
  // feat-20260601 D-3: view = invert(camera world mat4). The camera's resolved
  // world mat4 (propagateTransforms output) is read straight off the snapshot;
  // no recompose from decomposed TRS.
  const cameraFromWorld = mat4.create();
  // brand-cast-ok: camera.world is an existing snapshot view read as Mat4 input.
  mat4.invert(cameraFromWorld, camera.world as unknown as Mat4);
  return cameraFromWorld;
}

export function computeProjectionMatrix(camera: CameraSnapshot): Mat4 {
  // feat-20260613 M6 / w20: branch on projection variant. The view UBO
  // record path needs the right matrix shape so the main pass renders
  // correctly under both perspective and orthographic cameras (mirrors
  // the CSM extract fix in render-system-extract.ts).
  const proj = mat4.create();
  if (camera.projection === 'orthographic') {
    mat4.orthographic(
      proj,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoBottom,
      camera.orthoTop,
      camera.near,
      camera.far,
    );
  } else {
    mat4.perspective(proj, camera.fov, camera.aspect, camera.near, camera.far);
  }
  return proj;
}
