// @forgeax/engine-runtime - SkyboxBackground (environment cubemap render background).
//
// Schema: 2 fields -- cubemap (Handle<CubeTextureAsset>, u32-stored handle)
// + mode (f32 enum column, discriminator). Naming convention follows the
// single-semantic component rule: no Component suffix (AGENTS.md rule #1).
//
// Plan-strategy D-5: mode is a f32 enum column (ECS columns are POD, no
// string unions in archetype storage). Consumer-facing type safety is
// provided by the `SkyboxMode` literal union + `skyboxModeFromF32` mapper
// (same pattern as cameraProjectionFromF32 in camera.ts:51,105,145,221-237).
//
// OOS-1: `mode: 'atmosphere'` implementation is deferred -- the union
// shape leaves room for additive growth without breaking the f32 enum
// encoding.
//
// AI user minimum spawn (charter P4):
//   world.spawn({ component: SkyboxBackground, data: { cubemap, mode: 0 } });
//
// Single component activates the skybox render pass transparently when a
// Skylight + tonemap active camera is present (skybox reuses the same
// cubemap handle as Skylight).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Skybox mode literal union (AC-02 narrowing surface).
 * Currently only 'cubemap' -- future 'atmosphere' deferred per OOS-1.
 */
export type SkyboxMode = 'cubemap';

/** Numeric encoding of cubemap skybox mode (schema value for `mode`). */
export const SKYBOX_MODE_CUBEMAP = 0;

/**
 * Map a `SkyboxBackground.mode` numeric value to the closed `SkyboxMode`
 * string-literal union. Only member currently is 'cubemap'; the exhaustive
 * switch is ready for future mode additions (e.g. 'atmosphere', OOS-1).
 */
export function skyboxModeFromF32(value: number): SkyboxMode {
  switch (value) {
    case SKYBOX_MODE_CUBEMAP:
      return 'cubemap';
    // Future: case SKYBOX_MODE_ATMOSPHERE: return 'atmosphere';
  }
  // Unrecognised value: fall back to 'cubemap' (charter P3 -- no silent
  // exception; the fallback preserves rendering on stale numerics while
  // the exhaustive switch shape ensures AI users catch new members at
  // compile time when a mode is added).
  return 'cubemap';
}

/**
 * SkyboxBackground: full-screen environment cubemap background.
 *
 * Renders a fullscreen triangle that reconstructs world-space view
 * direction from the camera's inverseViewProj matrix (View UBO),
 * samples a cubemap with the view direction, and writes an HDR color
 * to the hdrColor render target (before the main geometry pass).
 *
 * The skybox pass is automatically activated when a SkyboxBackground
 * entity exists, a Skylight entity provides the cubemap, and the active
 * Camera has tonemap active. The skybox reuses the same cubemap handle
 * as the Skylight entity -- two independent components sharing the same
 * GPU resource.
 *
 * `cubemap` is a `Handle<CubeTextureAsset>` produced by
 * `engine.store.uploadCubemapFromEquirect(equirectHandle, equirectPod)`.
 *
 * `mode` is a numeric discriminator column (`'f32'`). Use
 * `SKYBOX_MODE_CUBEMAP` for the cubemap path.
 *
 * @example Minimum spawn (defaults mode=0):
 *   // cubemapHandle obtained from uploadCubemapFromEquirect (same as
 *   // the Skylight handle).
 *   world.spawn({ component: SkyboxBackground, data: { cubemap: cubemapHandle } });
 *
 * @example Single handle shared between Skylight (IBL) and SkyboxBackground:
 *   const cubeRes = await engine.store.uploadCubemapFromEquirect(hdrHandle, hdrPod);
 *   world.spawn({ component: Skylight,     data: { cubemap: cubeRes.value } });
 *   world.spawn({ component: SkyboxBackground, data: { cubemap: cubeRes.value } });
 */
export const SkyboxBackground = defineComponent('SkyboxBackground', {
  cubemap: { type: 'shared<CubeTextureAsset>' },
  mode: { type: 'f32', default: SKYBOX_MODE_CUBEMAP },
});
