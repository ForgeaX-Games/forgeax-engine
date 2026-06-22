#define_import_path forgeax_view::bloom_composite

// @forgeax/engine-shader - bloom-composite.wgsl
// (feat-20260531-bloom-first-declarative-render-graph-pass / w8).
//
// Fragment-stage additive HDR composite: blends the blurred bloom result
// back onto the original HDR scene color before tone mapping.
//
// Formula (LO 5.7 + intensity parameter):
//   hdrOut = hdrScene + intensity * bloomBlurV
//
// This pass runs at full resolution. The blurred bloom texture is at 1/2
// resolution but textureSampleLevel with bilinear filtering naturally
// upsamples to the full-resolution render target.
//
// Vertex stage: imports the SSOT fullscreen_triangle() from
// forgeax_view::common (single large triangle).
//
// Bindings (group 0):
//   @binding(0) hdrColor   : texture_2d<f32>   -- original HDR scene color
//   @binding(1) bloomBlurV : texture_2d<f32>   -- blurred bloom (V-pass output)
//   @binding(2) samp       : sampler           -- filterable sampler
//   @binding(3) params     : BloomCompositeParams (UBO) -- intensity + pad (16B std140)
//
// Content marker (marker triage): bloomComposite

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle

struct BloomCompositeParams {
  intensity : f32,
  pad0      : f32,
  pad1      : f32,
  pad2      : f32,
};

@group(0) @binding(0) var hdrColor   : texture_2d<f32>;
@group(0) @binding(1) var bloomBlurV : texture_2d<f32>;
@group(0) @binding(2) var samp       : sampler;
@group(0) @binding(3) var<uniform> params : BloomCompositeParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene : vec3<f32> = textureSampleLevel(hdrColor, samp, in.uv, 0.0).rgb;
  let bloom : vec3<f32> = textureSampleLevel(bloomBlurV, samp, in.uv, 0.0).rgb;
  // bloomComposite
  let result : vec3<f32> = scene + params.intensity * bloom;
  return vec4<f32>(result, 1.0);
}