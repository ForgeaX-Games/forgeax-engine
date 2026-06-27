#define_import_path forgeax_pbr::lighting_punctual

// @forgeax/engine-shader - lighting-punctual.wgsl
// (feat-20260523-shader-template-instance-split M5 / T02).
//
// Point + spot light evaluators extracted from pbr.wgsl
// (feat-20260519-light-casters-point-spot-pbr M4 / w22 byte-equivalent
// extraction). Both light types share a punctual BRDF body (GGX specular +
// Lambertian diffuse + KHR_lights_punctual quartic range attenuation); the
// only difference is that SpotLight multiplies a cone-falloff factor
// `smoothstep(cosOuter, cosInner, dot(l, -lightDir))` on top.
//
// charter P4 consistent abstraction: one body, two thin wrappers that each
// carry exactly the parameters their light type needs. evalPoint avoids the
// "evalPunctual(cosInner=1, cosOuter=-1, ...)" magic-value collapse pattern
// since `smoothstep(-1, 1, x)` is the Hermite cubic 0..1 (not a constant 1).
//
// Range attenuation (KHR_lights_punctual quartic):
//   atten = max(min(1 - (d^2 * invR^2)^2, 1), 0) / max(d^2, 1e-4)
// `max(d^2, 1e-4)` math safety net keeps the divisor finite when the
// fragment is at the light position (zero-distance NaN guard, layer 2 of
// the two-layer fail-fast strategy alongside the host-side bounds gate).
// `invRangeSquared = 0` collapses the quartic falloff to a pure 1/d^2 law.
//
// Pure-function module aside from the brdf #import; takes all light + surface
// parameters as args so the helper does not declare its own bindings (host
// material shader owns the @group(0) light buffer namespace).
//
// Exports:
//   - evalPoint(lightPos, colorTimesIntensity, invRangeSquared, ...) -> vec3<f32>
//   - evalSpot(lightPos, lightDir, colorTimesIntensity, cosInner, cosOuter,
//              invRangeSquared, ...) -> vec3<f32>

#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
// feat-20260625-spot-light-shadow-mapping M3 / w15 (plan-strategy D-3 + D-5):
// spot shadow sampling reuses the shared 2D 9-tap PCF core (sample_shadow_2d)
// and the always-on `spotShadowMap` (binding 8) + `shadowSampler` (binding 4).
// `shadowSampler` is imported UNCONDITIONALLY here (spot is always-on, D-5):
// the point-shadow #ifdef block below must NOT re-import it (double import).
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d}
#import forgeax_view::common::{spotShadowMap, shadowSampler}
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::shadow_pcf::{sample_shadow_cube_hw2x2}
// Pull in the @group(0) @binding(5) shadowAtlas declaration from common.wgsl so
// the free-identifier references in `evalPointShadowed` resolve through
// naga_oil's import scope. (`shadowSampler` is already imported above for the
// always-on spot path.)
#import forgeax_view::common::{shadowAtlas}
#endif

// Shared punctual BRDF body returning (diffuse + specular) *
// colorTimesIntensity * nDotL * attenuation. Cone factor is applied by the
// caller (evalSpot only).
fn evalPunctualBody(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let h = normalize(viewDir + l);
  let nDotL = max(dot(normal, l), 0.0);
  let nDotV = max(dot(normal, viewDir), 1e-5);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(viewDir, h), 0.0);
  let f = f_schlick(vDotH, F0);
  let specular = d_ggx(nDotH, alphaSq) * v_smith(nDotV, nDotL, alphaSq) * f;
  let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
  let diffuse = kd * baseColor / 3.14159265;
  let factor = 1.0 - (dSquared * invRangeSquared) * (dSquared * invRangeSquared);
  let attenuation = max(min(factor, 1.0), 0.0) / dSquared;
  return (diffuse + specular) * colorTimesIntensity * nDotL * attenuation;
}

// Omnidirectional point light: no cone factor.
fn evalPoint(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
) -> vec3<f32> {
  return evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0,
  );
}

#ifdef POINT_SHADOW_AVAILABLE
// Shadow-modulated omnidirectional point light: same BRDF body * shadow factor.
//
// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-3 + M4 / T-M4-3
// (plan-strategy §D-1 + §D-8). Only emitted when POINT_SHADOW_AVAILABLE is
// true (forward path with the cube_array atlas at @group(0) binding 5).
// The shadow factor is reconstructed from `lightLocal` via the largest-axis
// projection (research L0.5 Bevy pattern); the caller passes `near` / `far`
// directly so both pipelines route the same constants without owning the
// upstream binding (URP reads them from `shadowParams[layer]` at @group(0)
// binding 6; HDRP unpacks them off `LightSlot.kind_and_pad.zw` per
// plan-strategy §D-8).
//
// Caller responsibility: gate this on `shadowAtlasLayer >= 0` so the
// no-shadow lights stay on the unshadowed `evalPoint` path; passing a
// negative layer here is undefined (the cube_array view rejects it).
fn evalPointShadowed(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  shadowAtlasLayer    : i32,
  near                : f32,
  far                 : f32,
  depthBias           : f32,
  normalBias          : f32,
) -> vec3<f32> {
  let lit = evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0,
  );
  // Fragment-to-light direction; cubemap sample uses the local-space
  // direction (research L0.5: Bevy convention). For a right-handed world,
  // the cubemap convention flips Z so the +Z face look direction matches.
  let toLight = lightPos - worldPos;
  // Cubemap sample direction is from-fragment-to-light (Bevy + LearnOpenGL),
  // negated to fragment-from-light when reconstructing the depth ref.
  let lightLocal = vec3<f32>(toLight.x, toLight.y, -toLight.z);
  // Reconstruct [0,1] NDC depth from world-space distance: largest-axis
  // projection (research L0.5). Match the per-face perspective near / far
  // configured by buildPointShadowMatrices (PointLightShadow.nearPlane /
  // farPlane on the host).
  let absV = abs(vec3<f32>(toLight.x, toLight.y, toLight.z));
  let largestAxis = max(absV.x, max(absV.y, absV.z));
  // Perspective z-NDC reconstruction for the largest axis as the eye-space
  // -z component (cube face look direction is the +axis the absolute value
  // selected). z_ndc = far * (largest - near) / (largest * (far - near)).
  let denom = max(largestAxis * (far - near), 1e-6);
  let depthRef = clamp(far * (largestAxis - near) / denom, 0.0, 1.0);
  let nDotL = max(dot(normal, normalize(toLight)), 0.0);
  let shadowFactor = sample_shadow_cube_hw2x2(
    shadowAtlas, shadowSampler, lightLocal, shadowAtlasLayer,
    depthRef, depthBias, normalBias, nDotL,
  );
  return lit * shadowFactor;
}
#endif

// Cone-restricted spot light: BRDF body * smoothstep cone factor.
// `cosInner` / `cosOuter` are pre-computed cosines (host-side
// degree -> cosine conversion in extract-frame; plan-strategy D-S2).
fn evalSpot(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
) -> vec3<f32> {
  let body = evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0,
  );
  let toLight = lightPos - worldPos;
  let l = normalize(toLight);
  let cone = smoothstep(cosOuter, cosInner, dot(l, -lightDir));
  return body * cone;
}

// feat-20260625-spot-light-shadow-mapping M3 / w15 (plan-strategy D-3 + D-4 +
// D-5). Shadow-modulated spot light: the unshadowed `evalSpot` result times a
// PCF shadow factor sampled from the spot's perspective depth-atlas tile.
//
// Mirrors `evalPointShadowed`'s "shadowed wrapper + upstream gate" pattern
// (research Finding B3): the caller gates on `shadowAtlasTile >= 0` so
// no-shadow / clipped / direction-degenerate spots (tile = -1, plan D-4) stay
// on the unshadowed `evalSpot` path.
//
// Depth-ref reconstruction is the standard perspective `splane.z / splane.w`
// non-linear depth (plan-strategy D-4, godot-point-spot-shadows wiki S3.4):
// store-side and sample-side share the SAME perspective `lightViewProj`, so the
// projection's non-linearity cancels and no near/far reconstruction is needed
// (unlike the point cube path's largest-axis projection).
//
// Atlas tiling: the host packs up to 4 spot shadows into a 2x2 grid of one
// `spotShadowDepth` texture (urp-pipeline.ts). Tile N occupies quadrant
// (col = N % 2, row = N / 2); the [0,1] light-clip UV is scaled to a 0.5x0.5
// sub-rect and offset to the tile origin. PCF taps stay inside the tile by
// scaling the texel step to the half-resolution sub-rect.
//
// OOB / NaN gate (research Finding F1, mirrors lighting-directional.wgsl): a
// degenerate `lightViewProj` (near-zero spot direction) yields NaN UVs; the
// `>= 0 && <= 1` form is false for NaN, so the fragment returns fully lit
// (shadowFactor = 1.0) instead of a hard-black artifact.
fn evalSpotShadowed(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  lightViewProj       : mat4x4<f32>,
  shadowAtlasTile     : i32,
  depthBias           : f32,
  normalBias          : f32,
) -> vec3<f32> {
  let body = evalSpot(
    lightPos, lightDir, colorTimesIntensity, cosInner, cosOuter, invRangeSquared,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0,
  );

  // Project the fragment into the spot's light clip space.
  let splane = lightViewProj * vec4<f32>(worldPos, 1.0);
  // Perspective divide; guard a zero/near-zero w (fragment behind the light or
  // a degenerate matrix) so the OOB gate below catches it as fully lit.
  let invW = select(1.0 / splane.w, 0.0, abs(splane.w) < 1e-6);
  let ndcXY = splane.xy * invW;
  let depthRef = splane.z * invW;
  // Clip-space [-1,1] -> texture UV [0,1] with the standard Y flip.
  let clipUv = vec2<f32>(ndcXY.x * 0.5 + 0.5, ndcXY.y * -0.5 + 0.5);

  // OOB / NaN gate: outside the light frustum (or NaN from a degenerate matrix)
  // returns fully lit. Mirrors the directional `>= 0 && <= 1` NaN-safe form.
  if (!(clipUv.x >= 0.0 && clipUv.x <= 1.0 && clipUv.y >= 0.0 && clipUv.y <= 1.0 && depthRef <= 1.0)) {
    return body;
  }

  // Map the [0,1] light-clip UV into the spot's 2x2 atlas tile sub-rect.
  let col = f32(shadowAtlasTile % 2);
  let row = f32(shadowAtlasTile / 2);
  let tileOrigin = vec2<f32>(col, row) * 0.5;
  let atlasUv = clipUv * 0.5 + tileOrigin;

  // texel step within the half-resolution sub-rect (atlas is 2x tile size).
  let atlasDims = vec2<f32>(textureDimensions(spotShadowMap, 0));
  let texel = vec2<f32>(1.0, 1.0) / atlasDims;

  let nDotL = max(dot(normal, normalize(lightPos - worldPos)), 0.0);
  let shadowFactor = sample_shadow_2d(
    spotShadowMap, shadowSampler, atlasUv, texel, depthRef, normalBias, depthBias, nDotL,
  );
  return body * shadowFactor;
}
