#define_import_path forgeax_pbr::lighting_directional

// @forgeax/engine-shader - lighting-directional.wgsl
// (feat-20260523-shader-template-instance-split M5 / T02;
//  feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path M5 / w18 rewrite).
//
// Directional-light evaluator extracted from pbr.wgsl. Cook-Torrance
// (D_GGX + V_Smith + F_Schlick) microfacet specular + Lambertian diffuse,
// modulated by a slope-scaled-bias 3x3 PCF shadow lookup against the
// host's CSM shadow atlas (LearnOpenGL 3.1.3 PCF model + Bevy-style
// cascaded shadow maps).
//
// Cascade selection (feat-20260613 AC-03 / AC-06 / AC-10):
//   1. Pick layer in 0..cascadeCount-1 based on viewZ vs splitPlanes[i].
//      The same code path covers a 1-layer config (single tile) and a
//      4-layer config (Bevy default) -- AC-03 forbids any single-cascade
//      fallback branch.
//   2. Project worldPos through the matching lightViewProj. The host emits
//      pure clip-space matrices (orthoProj * lightView with no tile-UV
//      pre-bake); this helper performs atlas tile UV placement on the
//      fragment side so shadow_caster can keep gl_Position in clip space
//      (w28 split-of-roles -- writer and reader share one matrix shape).
//   3. textureSampleCompareLevel against shadowMap (the atlas) with a
//      slope-scaled bias (LO 3.1.3) and 3x3 PCF tap kernel.
//   4. When cascadeBlend > 0 and the fragment lies near the cascade
//      boundary, mix(shadow_curr, shadow_next, t) where t walks 0->1
//      across a band of width splitPlanes[layer] * cascadeBlend.
//
// feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-2 (plan-strategy D-4):
// 9-tap PCF taps come from shared sample_shadow_2d in forgeax_pbr::shadow_pcf.
// Bias formula and 9-tap kernel are byte-equivalent to the prior inline
// version (research L1.5 lines 47-81); the shared core is the single SSOT
// for directional + point-light PCF.
//
// Pulls View + shadowMap from forgeax_view::common -- the helper inherits
// the group(0) binding namespace from the host material shader (every
// consumer already imports forgeax_view::common). Shadow PCF taps use
// textureSampleCompareLevel against the comparison sampler so the path
// is portable across WebGPU + GLES.
//
// Exports:
//   - evalDirectional(...) -> vec3<f32>

#import forgeax_view::common::{view, shadowMap, shadowSampler}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d}

// feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
// compile-time upper bound on the PCF half-extent so the WGSL tap loops keep
// a constant trip count (no dynamic loop bounds / shader variants). half=2
// covers pcfKernelSize in {1,3,5} -> {1,9,25} taps; view.pcfKernelSize selects
// the runtime radius via a per-iteration clip (plan-strategy D-1).
const MAX_PCF_HALF : u32 = 2u;

// Pick the cascade layer for a positive view-space depth -- walks
// splitPlanes in order, returns the first split the depth falls below. Last
// layer (count - 1) catches everything beyond splits[count-2]. cascadeCount=1
// returns 0 unconditionally without a special branch (count - 1u == 0
// short-circuits the loop trip count).
//
// NOTE the sign: the vertex stage emits `viewZ = -clipPos.w` (NEGATIVE in
// front of the camera -- the deliberate convention the cluster Z-slice path
// also relies on), but `pssmSplit` host-side produces POSITIVE view-space
// split depths. The caller therefore passes `viewDepth = -viewZ` so this
// comparison is positive-vs-positive. Comparing the raw negative viewZ against
// positive splits collapsed every visible fragment to layer 0 (its near slab),
// projecting far geometry out of the tile -> shadowFactor always 1.0 (no
// occlusion). (downstream template integration #1.)
fn _pickCascadeLayer(viewDepth : f32, count : u32) -> u32 {
  var layer : u32 = count - 1u;
  for (var i : u32 = 0u; i < count - 1u; i = i + 1u) {
    let sp = view.splitPlanes[i].x;
    if (viewDepth < sp) {
      layer = i;
      break;
    }
  }
  return layer;
}

// Look up the lightViewProj matrix for layer index. View UBO carries 4
// distinct fields (lightViewProj_A..D); WGSL has no addressable mat4
// array on a uniform, so a manual switch keeps the path uniform.
fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

// Map a cascade layer to its atlas-tile origin in [0,1]^2 UV space.
// tilesPerSide = 2 covers cascadeCount in 1..4 (atlas = 2 × mapSize).
// cascadeCount=1 collapses to tile (0,0); the same code path applies.
fn _atlasTileOrigin(layer : u32, count : u32) -> vec2<f32> {
  // tilesPerSide = ceil(sqrt(count)). count<=1 -> 1; count<=4 -> 2.
  // Branch-free: count<=1 -> 1, else 2.
  let tilesPerSide : u32 = select(2u, 1u, count <= 1u);
  let col = layer % tilesPerSide;
  let row = layer / tilesPerSide;
  let inv = 1.0 / f32(tilesPerSide);
  return vec2<f32>(f32(col) * inv, f32(row) * inv);
}

// Sample the shadow atlas with the LO 3.1.3 slope-scaled bias + dynamic PCF
// kernel (driven by view.pcfKernelSize, MAX_PCF_HALF=2),
// against the lightViewProj for the chosen cascade. The shader maps NDC
// xy to that cascade's atlas tile in fragment space (matrix carries
// clip-space; tile placement happens here so shadow_caster.gl_Position
// stays in the WGSL clip-space contract).
fn _sampleShadowForCascade(
  worldPos : vec3<f32>,
  layer    : u32,
  count    : u32,
  normal   : vec3<f32>,
  l        : vec3<f32>,
) -> f32 {
  let lvp = _cascadeLightViewProj(layer);
  let lightClip = lvp * vec4<f32>(worldPos, 1.0);
  let projCoords = lightClip.xyz / lightClip.w;
  let tilesPerSide : u32 = select(2u, 1u, count <= 1u);
  let inv = 1.0 / f32(tilesPerSide);
  let tileOrigin = _atlasTileOrigin(layer, count);
  // NDC [-1,1] -> tile-local UV [0,inv] -> atlas UV [tileOrigin, tileOrigin+inv].
  let tileUv = vec2<f32>(projCoords.x * 0.5 + 0.5, -projCoords.y * 0.5 + 0.5);
  let uv = tileUv * inv + tileOrigin;
  let currentDepth = projCoords.z;
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t4
  // (D-1): the slope-scaled bias is driven by the merged DirectionalLight's
  // shadow fields carried in the View UBO -- normalBias scales the
  // (1 - N.L) slope term, depthBias is the constant floor. Replaces the prior
  // hardcoded max(0.05*(1-N.L), 0.005).
  let bias = max(view.normalBias * (1.0 - dot(normal, l)), view.depthBias);
  let adjustedDepth = currentDepth - bias;
  // NaN-safe bounds: relational < and > do not reject NaN (NaN < 0 is
  // false), so a zero / degenerate lightViewProj matrix that produces
  // 0/0 = NaN would slip through. Use x >= 0 && x <= 1 instead -- NaN
  // makes the conjunction false and the early-return fires (shadow=1.0).
  // Matches the main-line pattern that survived the transform-hierarchy
  // dawn regression test (AC-08 parent-move pixel-diff on main).
  if (!(tileUv.x >= 0.0 && tileUv.x <= 1.0 && tileUv.y >= 0.0 && tileUv.y <= 1.0 && currentDepth <= 1.0)) {
    return 1.0;
  }
  let texelDims = vec2<f32>(textureDimensions(shadowMap, 0));
  let texel = vec2<f32>(1.0 / texelDims.x, 1.0 / texelDims.y);
  // AC-07 (bug-20260619): the OOB guard above is in tile-local space, but the
  // PCF tap offset is applied in atlas space. For count>1 (inv<1) a fragment
  // within one texel of a tile edge would sample into a NEIGHBOURING cascade's
  // tile, reading the wrong depth and producing a 1-texel seam at cascade
  // boundaries. Clamp every tap to this cascade's tile rect
  // [tileOrigin, tileOrigin+inv) (one texel inset) so taps stay in-tile. For
  // count<=1 (single full-atlas tile) this is a no-op widening of the bound.
  let tileLo = tileOrigin + texel;
  let tileHi = tileOrigin + vec2<f32>(inv) - texel;
  // Variable-width PCF kernel driven by view.pcfKernelSize (feat-20260621
  // 5.3-production-shadow-demos AC-14 merged with the DirectionalLightShadow
  // merge). Constant trip count to MAX_PCF_HALF with a per-iteration clip to the
  // runtime radius keeps the shader variant-free (no dynamic loop bound, legal
  // for textureSampleCompareLevel uniform control flow). Host clamps
  // view.pcfKernelSize to {1,3,5}; divisor = actual tap count, so pcfKernelSize=3
  // -> half=1 -> 9 taps / 9.0 (result-identical to the prior hard-coded 3x3);
  // pcfKernelSize=1 -> half=0 -> single centre tap (hard edge); pcfKernelSize=5
  // -> half=2 -> 25-tap soft penumbra.
  let kernel = clamp(u32(round(view.pcfKernelSize)), 1u, 2u * MAX_PCF_HALF + 1u);
  let half = (kernel - 1u) / 2u;
  let halfI = i32(half);
  var blocked = 0.0;
  for (var x = -i32(MAX_PCF_HALF); x <= i32(MAX_PCF_HALF); x++) {
    for (var y = -i32(MAX_PCF_HALF); y <= i32(MAX_PCF_HALF); y++) {
      if (abs(x) > halfI || abs(y) > halfI) {
        continue;
      }
      let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * texel, tileLo, tileHi);
      let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, adjustedDepth);
      blocked = blocked + (1.0 - lit);
    }
  }
  let tapCount = f32((2u * half + 1u) * (2u * half + 1u));
  return 1.0 - blocked / tapCount;
}

// `evalDirectional` evaluates the GGX direct-lighting term for the single
// directional light carried in `view.lightDir / view.lightColor`. CSM
// pathway: pick cascade layer from viewZ + splitPlanes, sample the atlas
// tile via the matching lightViewProj, optionally blend with the next
// cascade across a `cascadeBlend`-wide boundary band.
fn evalDirectional(
  normal     : vec3<f32>,
  viewDir    : vec3<f32>,
  baseColor  : vec3<f32>,
  metallic   : f32,
  alphaSq    : f32,
  F0         : vec3<f32>,
  worldPos   : vec3<f32>,
  viewZ      : f32,
) -> vec3<f32> {
  let l = normalize(-view.lightDir);
  let h = normalize(viewDir + l);
  let nDotL = max(dot(normal, l), 0.0);
  let nDotV = max(dot(normal, viewDir), 1e-5);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(viewDir, h), 0.0);
  let f = f_schlick(vDotH, F0);
  let specular = d_ggx(nDotH, alphaSq) * v_smith(nDotV, nDotL, alphaSq) * f;
  let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
  let diffuse = kd * baseColor / 3.14159265;

  // Cascade selection + atlas sampling (AC-03 / AC-05 / AC-06 / AC-10).
  // feat-20260613-csm-cascaded-shadow-maps M5 / w18: uses inline 9-tap PCF
  // inside `_sampleShadowForCascade` rather than the shared sample_shadow_2d
  // (forgeax_pbr::shadow_pcf used by point-light) — the cascade dispatch
  // wraps the kernel per-tile so the shared core's `(uv, currentDepth)`
  // entry shape doesn't fit (it expects pre-projected light-space coords;
  // CSM derives them per-cascade after dispatch). F-J-1 future-tracks the
  // dedup once `forgeax_view::cascade` lands as its own module (post-#387).
  let count = u32(max(view.cascadeCount, 1.0));
  // viewZ is negative in front of the camera; splitPlanes are positive
  // view-space depths. Convert once so cascade selection + blend math are
  // positive-vs-positive (see _pickCascadeLayer).
  let viewDepth = -viewZ;
  let layer = _pickCascadeLayer(viewDepth, count);
  let shadowCurr = _sampleShadowForCascade(worldPos, layer, count, normal, l);

  // cascadeBlend mixes the current cascade with the next one across a
  // band of width `splitPlanes[layer] * cascadeBlend` immediately before
  // the boundary. cascadeBlend=0 -> hard cut. Last cascade has no
  // successor; mix collapses to shadowCurr.
  var shadow = shadowCurr;
  if (view.cascadeBlend > 0.0 && layer + 1u < count) {
    let spCurr = view.splitPlanes[layer].x;
    let blendWidth = spCurr * view.cascadeBlend;
    if (blendWidth > 0.0) {
      // Positive view-space depth (viewDepth), matching spCurr's sign;
      // `dist` shrinks to 0 as the fragment approaches the split boundary.
      let dist = spCurr - viewDepth;
      let t = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
      if (t > 0.0) {
        let shadowNext = _sampleShadowForCascade(worldPos, layer + 1u, count, normal, l);
        shadow = mix(shadowCurr, shadowNext, t);
      }
    }
  }

  return (diffuse + specular) * view.lightColor * nDotL * shadow;
}