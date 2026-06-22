#define_import_path forgeax_view::bloom_blur

// @forgeax/engine-shader - bloom-blur.wgsl
// (feat-20260531-bloom-first-declarative-render-graph-pass / w7).
//
// Fragment-stage separable Gaussian blur: 5-weight kernel (radius 4,
// 9 taps per pass -- centre + 4 left + 4 right) sampled via
// textureSampleLevel(tex, samp, uv, 0.0) for uniform-control-flow safety.
//
// Design (plan-strategy D-1, D-4): NO if(horizontal) branch in this
// shader. The axis direction is baked per-pipeline at assembly by the
// host: the H-pipeline passes texelSize=(1/textureW, 0), the V-pipeline
// passes texelSize=(0, 1/textureH). The shader always applies the same
// offset loop -- the direction emerges from the UBO texelSize parameter.
//
// Kernel weights (LO 5.7, radius 4, sigma ~1.0):
//   centre: 0.227027
//   +-1:    0.1945946
//   +-2:    0.1216216
//   +-3:    0.054054
//   +-4:    0.016216
//   Sum: ~0.99854 (truncated Gaussian slight darkening is normal).
//
// The radius parameter (1.0-4.0 clamped) controls how many taps are
// active: floor-clamp(radius) selects the range index [1,4], with the
// centre weight renormalised to keep the sum near 1.0.
//
// Vertex stage: imports the SSOT fullscreen_triangle() from
// forgeax_view::common (single large triangle).
//
// Bindings (group 0):
//   @binding(0) src    : texture_2d<f32>   -- sampled input texture
//   @binding(1) samp   : sampler           -- filterable sampler
//   @binding(2) params : BloomBlurParams (UBO) -- texelSize + radius (16B std140)
//
// Content marker (marker triage): bloomBlurDir

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle

struct BloomBlurParams {
  texelSizeX : f32,
  texelSizeY : f32,
  radius     : f32,
  pad0       : f32,
};

@group(0) @binding(0) var src  : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var<uniform> params : BloomBlurParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let texelSize : vec2<f32> = vec2<f32>(params.texelSizeX, params.texelSizeY);
  let r : f32 = clamp(params.radius, 1.0, 4.0);
  let center : vec3<f32> = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  var result : vec3<f32> = center * 0.227027;
  // bloomBlurDir
  result += textureSampleLevel(src, samp, in.uv + texelSize * 1.0, 0.0).rgb * 0.1945946;
  result += textureSampleLevel(src, samp, in.uv - texelSize * 1.0, 0.0).rgb * 0.1945946;
  if r >= 2.0 {
    result += textureSampleLevel(src, samp, in.uv + texelSize * 2.0, 0.0).rgb * 0.1216216;
    result += textureSampleLevel(src, samp, in.uv - texelSize * 2.0, 0.0).rgb * 0.1216216;
  } else {
    result += center * 0.1216216;
    result += center * 0.1216216;
  }
  if r >= 3.0 {
    result += textureSampleLevel(src, samp, in.uv + texelSize * 3.0, 0.0).rgb * 0.054054;
    result += textureSampleLevel(src, samp, in.uv - texelSize * 3.0, 0.0).rgb * 0.054054;
  } else {
    result += center * 0.054054;
    result += center * 0.054054;
  }
  if r >= 4.0 {
    result += textureSampleLevel(src, samp, in.uv + texelSize * 4.0, 0.0).rgb * 0.016216;
    result += textureSampleLevel(src, samp, in.uv - texelSize * 4.0, 0.0).rgb * 0.016216;
  } else {
    result += center * 0.016216;
    result += center * 0.016216;
  }
  return vec4<f32>(result, 1.0);
}