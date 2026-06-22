// @forgeax/engine-runtime - Skylight (ambient environment light).
//
// Schema: 5 fields -- cubemap (Handle<CubeTextureAsset>, u32-stored handle,
// OPTIONAL) + colorR/G/B (f32, default 1 = white) + intensity (f32, default
// 1.0). Naming convention follows the DirectionalLight / PointLight /
// SpotLight family: no Component suffix (AGENTS.md rule #1).
//
// Plan-strategy D-6: Skylight component schema is registered but no
// independent ECS system is created. All Skylight processing happens inside
// RenderSystem's extract/record phases.
//
// AI user minimum spawn (AC-13, charter P4):
//   world.spawn({ component: Skylight, data: {} });  // instant white ambient
//
// A single Skylight activates ambient lighting transparently. The `cubemap`
// field is OPTIONAL: omit it for a constant solid-color ambient that needs NO
// async GPU precompute -- the engine binds a 1x1 white irradiance cube, so
// ambient = color * intensity * albedo is live on the very first frame (this
// is the fix for the downstream "scene is black until the async IBL cubemap
// finishes uploading" gap). Supply a cubemap to upgrade to full image-based
// lighting (diffuse irradiance + specular prefilter); `color` * `intensity`
// still scales the IBL result, so both are live dynamic dials either way.
//
// Edge cases handled by t27 / t26:
//   - Multi-Skylight: first archetype hit wins, console.warn in dev+prod
//   - intensity=0: ambient term = 0, mathematically valid, no warn
//   - No cubemap: solid-color ambient via the white fallback cube (no async)

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Skylight ambient environment light.
 *
 * A single Skylight entity provides ambient lighting for all StandardMaterial
 * surfaces. Two modes share one component:
 *
 * - **Solid-color ambient (no cubemap).** Omit `cubemap` for a constant
 *   ambient = `color` * `intensity` applied immediately, with no async GPU
 *   precompute. The engine samples a built-in 1x1 white irradiance cube, so a
 *   freshly-loaded scene is lit on its first frame instead of being black
 *   until an IBL upload finishes.
 * - **Image-based lighting (with cubemap).** Supply `cubemap` to upgrade to
 *   diffuse irradiance + specular prefilter IBL. The engine runs the full
 *   precompute (equirect->cubemap, irradiance convolution, prefilter mip
 *   chain, BRDF LUT) transparently; `color` * `intensity` then scale the IBL
 *   ambient.
 *
 * `cubemap` is an OPTIONAL `Handle<CubeTextureAsset>` produced by
 * `engine.store.uploadCubemapFromEquirect(equirectHandle, equirectPod)`. The
 * handle is idempotent: same source handle returns the same cube handle.
 *
 * `colorR` / `colorG` / `colorB` is the linear-space ambient tint (default
 * white 1,1,1). `intensity` is a linear multiplier (default 1.0; 0 disables
 * ambient). Both are read every frame, so they are live dynamic dials.
 *
 * @example Instant white ambient (no asset, no async):
 *   world.spawn({ component: Skylight, data: {} });
 *
 * @example Dim warm ambient:
 *   world.spawn({ component: Skylight, data: { colorR: 1, colorG: 0.9, colorB: 0.8, intensity: 0.3 } });
 *
 * @example Full IBL from an HDR equirect:
 *   // 1. resolve GUID from vite pack-index (see forgeax-engine-vite-plugin-pack)
 *   import { AssetGuid } from '@forgeax/engine-pack';
 *   const guidRes = AssetGuid.parse('019e4a26-3c29-7420-af5d-20f2724a16b0');
 *   if (!guidRes.ok) throw guidRes.error;
 *   // 2. load HDR equirect via the GUID-addressed pack route
 *   const hdrRes = await engine.assets.loadByGuid<TextureAsset>(guidRes.value);
 *   if (!hdrRes.ok) throw hdrRes.error;
 *   // 3. precompute the IBL cubemap chain (idempotent on same equirect handle)
 *   const hdrPod = engine.assets.get<TextureAsset>(hdrRes.value);
 *   if (!hdrPod.ok) throw hdrPod.error;
 *   const cubeRes = await engine.store.uploadCubemapFromEquirect(hdrRes.value, hdrPod.value);
 *   if (!cubeRes.ok) throw cubeRes.error;
 *   // 4. spawn the Skylight component — the cubemap activates the full IBL path
 *   world.spawn({ component: Skylight, data: { cubemap: cubeRes.value } });
 */
export const Skylight = defineComponent('Skylight', {
  cubemap: { type: 'shared<CubeTextureAsset>' },
  colorR: { type: 'f32', default: 1.0 },
  colorG: { type: 'f32', default: 1.0 },
  colorB: { type: 'f32', default: 1.0 },
  intensity: { type: 'f32', default: 1.0 },
});
