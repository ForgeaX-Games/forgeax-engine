#define_import_path forgeax_pbr::shadow_pcf

// @forgeax/engine-shader - shadow-pcf.wgsl
// feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1 (plan-strategy D-4).
//
// Shared PCF (percentage-closer filtering) for directional and point-light
// shadow sampling. Single SSOT for the slope-scaled bias formula and 9-tap 3x3
// kernel-offset table. Directional shadows (2D) and point-light shadows
// (cube_array) each have their own wrapper function; the bias formula and
// offset table are shared.
//
// Exports:
//   - PCF_OFFSETS: const array<vec2<i32>, 9> — 3x3 kernel offset table
//   - sample_shadow_2d(...) -> f32 — directional 2D 9-tap software PCF
//   - sample_shadow_cube_hw2x2(...) -> f32 — point cube hardware 2x2 PCF
//
// Bias formula (byte-equivalent to the original lighting-directional.wgsl
// inline PCF, research L1.5 lines 47-81):
//   bias = max(depthBias * (1.0 - dot(N, L)), normalBias / 1000.0)
//
// Return: 1.0 = fully lit, 0.0 = fully shadowed.

// 3x3 integer offset table for PCF kernel (9 taps).
// Extracted from lighting-directional.wgsl inline loop (T-M2-4);
// `sample_shadow_2d` walks all 9 taps; `sample_shadow_cube_hw2x2` does NOT
// use this table (cubemap sampling has no UV parameterization across face
// seams — see Round-2 F-2 finding).
const PCF_OFFSETS = array<vec2<i32>, 9>(
  vec2<i32>(-1, -1), vec2<i32>( 0, -1), vec2<i32>( 1, -1),
  vec2<i32>(-1,  0), vec2<i32>( 0,  0), vec2<i32>( 1,  0),
  vec2<i32>(-1,  1), vec2<i32>( 0,  1), vec2<i32>( 1,  1),
);

// === 2D directional-shadow wrapper ============================================
//
// `shadowMap` and `shadowSampler` are @group(0) @binding(3/4) from
// forgeax_view::common. `uv` is the [0,1]^2 projected light-clip coordinate.
// `texel` is 1.0 / textureDimensions(shadowMap, 0) precomputed by the caller.
//
// The caller must perform the OOB gate `uv in [0,1] && depthRef <= 1.0` before
// calling this function; OOB returns fully lit (1.0) upstream.

fn sample_shadow_2d(
  shadowMap    : texture_depth_2d,
  shadowSampler: sampler_comparison,
  uv           : vec2<f32>,
  texel        : vec2<f32>,
  depthRef     : f32,
  depthBias    : f32,
  normalBias   : f32,
  nDotL        : f32,
) -> f32 {
  // Slope-scaled bias: byte-equivalent to original lighting-directional.wgsl
  // inline constants (max(0.05*(1-dot(N,L)), 0.005)), research L1.5 lines 59-60.
  let bias = max(depthBias * (1.0 - nDotL), normalBias / 1000.0);
  let adjustedDepth = depthRef - bias;

  // 9-tap 3x3 PCF kernel. textureSampleCompareLevel returns 1.0 when
  // adjustedDepth < sampledDepth (sampler compare op = 'less'), 0.0 otherwise.
  // Sampler uses clamp-to-edge wrap so OOB texels return the nearest border value.
  var blocked = 0.0;
  for (var i = 0u; i < 9u; i++) {
    let off = PCF_OFFSETS[i];
    let offsetUv = uv + vec2<f32>(f32(off.x), f32(off.y)) * texel;
    let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, adjustedDepth);
    blocked = blocked + (1.0 - lit);
  }
  return 1.0 - blocked / 9.0;
}

// === Cube point-light-shadow wrapper =========================================
//
// `shadowAtlas` is @group(0) @binding(5) texture_depth_cube_array.
// `shadowSampler` is @group(0) @binding(4) sampler_comparison (shared with
// directional shadows — same sampler type, no dimension distinction).
// `lightLocal` is the fragment-to-light direction vector in the cubemap's
// coordinate system (Bevy convention: left-handed cubemap; caller applies
// flip_z = vec3(1,1,-1) to convert right-hand world to left-hand cubemap).
// `layer` is the cube_array layer index (i32; 0..3 for 4 shadow-casting
// point lights; sentinel -1 must be gated upstream — this function assumes
// a valid layer).
// `depthRef` is the reconstructed [0,1] NDC depth (largest-axis projection,
// research L0.5 Bevy fetch_point_shadow pattern).
//
// Hardware 2x2 PCF only: 2D texel offsets from PCF_OFFSETS have no direct 3D
// cubemap mapping (no UV parameterization across face seams). A previous
// 9-tap loop using the same cubemap direction every iteration was algorithmic
// dead code — every iteration returned the same `lit` value, so 9-tap = 1-tap
// (Reviewer F-2). This single call lets the GPU's silicon-level 2x2 PCF
// resolve the local neighborhood within each face natively. Matches Bevy's
// HARDWARE_2X2 path (research L0.6) and README §AC-11 default. Software 9-tap
// on cubemaps requires face-basis vector offsets and is OOS-3 here.

fn sample_shadow_cube_hw2x2(
  shadowAtlas   : texture_depth_cube_array,
  shadowSampler : sampler_comparison,
  lightLocal    : vec3<f32>,
  layer         : i32,
  depthRef      : f32,
  depthBias     : f32,
  normalBias    : f32,
  nDotL         : f32,
) -> f32 {
  // Slope-scaled bias: same formula as 2D path, shared SSOT.
  let bias = max(depthBias * (1.0 - nDotL), normalBias / 1000.0);
  let adjustedDepth = depthRef - bias;

  // Single textureSampleCompareLevel call: the comparison sampler resolves a
  // 2x2 PCF neighborhood at the silicon level; clamp-to-edge address mode
  // handles face-boundary texel fetches. Returns 1.0 = fully lit, 0.0 = fully
  // shadowed.
  return textureSampleCompareLevel(shadowAtlas, shadowSampler, lightLocal, layer, adjustedDepth);
}