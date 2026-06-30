#define_import_path forgeax_view::bloom_bright

// @forgeax/engine-shader - bloom-bright.wgsl
// (feat-20260531-bloom-first-declarative-render-graph-pass / w6).
//
// Fragment-stage bright-pass: extracts pixels whose Rec.709 relative
// luminance exceeds the threshold parameter, outputting to a 1/2-res
// rgba16float intermediate texture. Pixels below threshold are zeroed.
//
// Vertex stage: imports the SSOT fullscreen_triangle() from
// forgeax_view::common (single large triangle).
//
// Fragment stage: computes Rec.709 luminance via
//   L = dot(rgb, vec3(0.2126, 0.7152, 0.0722))
// and outputs rgb when L > threshold else vec3(0).
//
// Bindings (group 0):
//   @binding(0) hdrColor : texture_2d<f32>   -- sampled HDR color attachment
//   @binding(1) samp     : sampler           -- filterable sampler
//   @binding(2) params   : BloomBrightParams (UBO) -- threshold + pad (16B std140)
//
// Content marker (marker triage): bloomBrightExtract

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle

struct BloomBrightParams {
  threshold : f32,
  pad0      : f32,
  pad1      : f32,
  pad2      : f32,
};

@group(0) @binding(0) var hdrColor : texture_2d<f32>;
@group(0) @binding(1) var samp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomBrightParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let color : vec3<f32> = textureSampleLevel(hdrColor, samp, in.uv, 0.0).rgb;
  let luma : f32 = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  // bloomBrightExtract
  let bright : vec3<f32> = select(vec3<f32>(0.0), color, luma > params.threshold);
  return vec4<f32>(bright, 1.0);
}