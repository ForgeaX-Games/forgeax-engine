#define_import_path forgeax_view::tonemap

// @forgeax/engine-shader - tonemap.wgsl
// (feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.3).
//
// Fragment-stage extended Reinhard luminance tone-mapping shader. Routes the
// output of an HDR rgba16float color attachment through a fullscreen pass
// that compresses high-intensity pixels into the [0, 1] LDR band suitable
// for the bgra8unorm-srgb swap-chain.
//
// Vertex stage: imports the SSOT `fullscreen_triangle()` from
// `forgeax_view::common` (research F3 section 2.3 single-large-triangle).
//
// Fragment stage formula (luminance Reinhard 2002 extended):
//   exposed = textureSample(hdr, samp, uv).rgb * params.exposure
//   Y       = dot(exposed, vec3(0.2126, 0.7152, 0.0722))   // Rec. 709
//   Y_prime = Y * (1.0 + Y / (Lw * Lw)) / (1.0 + Y)
//   scale   = Y_prime / max(Y, TONEMAP_LUMINANCE_EPSILON)
//   out.rgb = exposed * scale
//   out.a   = 1.0
//
// `TONEMAP_LUMINANCE_EPSILON` (1e-5) is the shared TS / WGSL floor (D-O3)
// keeping the divisor finite at degenerate inputs (Y = 0 / negative). The
// constant is also exposed via `@forgeax/engine-shader#TONEMAP_LUMINANCE_EPSILON`
// so the TS-equivalence test in tonemap-shader.test.ts uses the same value.
//
// Bindings (group 1):
//   @binding(0) hdr   : texture_2d<f32>      // sampled HDR color attachment
//   @binding(1) samp  : sampler              // filterable sampler
//   @binding(2) params: TonemapParams (UBO)  // exposure + whitePoint
//
// feat-20260621 M-A3 / w16 (D-5): the built-in tonemap flows through the SAME
// unified fullscreen post-process channel as custom post-processes
// (`postProcess.register('forgeax::tonemap', { source, params })`). That channel
// binds the input-texture + sampler + params UBO at group(1) (group(0) is the
// reserved empty view-BGL), so all three bindings moved from group(0) to
// group(1). The binding numbers (0/1/2) are unchanged.
//
// `TonemapParams` is std140-aligned to 16 B (4 f32). The host writes a
// Float32Array of length 4 each frame: [exposure, whitePoint, 0, 0].

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle

const TONEMAP_LUMINANCE_EPSILON : f32 = 1e-5;

struct TonemapParams {
  exposure   : f32,
  whitePoint : f32,
  mode       : u32,
  pad1       : f32,
};

@group(1) @binding(0) var hdr  : texture_2d<f32>;
@group(1) @binding(1) var samp : sampler;
@group(1) @binding(2) var<uniform> params : TonemapParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

fn tonemapReinhardExtended(color : vec3<f32>) -> vec3<f32> {
  let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let lw_sq = params.whitePoint * params.whitePoint;
  let luma_prime = (luma * (1.0 + luma / lw_sq)) / (1.0 + luma);
  let scale = luma_prime / max(luma, TONEMAP_LUMINANCE_EPSILON);
  return color * scale;
}

fn tonemapLinear(color : vec3<f32>) -> vec3<f32> {
  return color;
}

fn tonemapCineon(color : vec3<f32>) -> vec3<f32> {
  let x = max(vec3<f32>(0.0), color - 0.004);
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}

fn tonemapAcesFilmic(color : vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapAgx(color : vec3<f32>) -> vec3<f32> {
  let agxMat = mat3x3<f32>(
    vec3<f32>(0.842479, 0.0784336, 0.0792237),
    vec3<f32>(0.0423303, 0.878468, 0.0791661),
    vec3<f32>(0.0423745, 0.0784336, 0.879142),
  );
  let agxMatInv = mat3x3<f32>(
    vec3<f32>(1.19687, -0.0980208, -0.0990297),
    vec3<f32>(-0.0528968, 1.15190, -0.0989611),
    vec3<f32>(-0.0529716, -0.0980434, 1.15107),
  );
  let compressed = agxMat * color;
  let logC = clamp(log2(max(compressed, vec3<f32>(1e-10))), vec3<f32>(-12.47393), vec3<f32>(4.026069));
  let normalized = (logC - vec3<f32>(-12.47393)) / (4.026069 - (-12.47393));
  let s = normalized * normalized * (3.0 - 2.0 * normalized);
  return agxMatInv * s;
}

fn tonemapNeutral(color : vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color, vec3<f32>(startCompression));
  let over = max(color - startCompression, vec3<f32>(0.0));
  let compressed = x + over / (1.0 + over);
  let luma = dot(compressed, vec3<f32>(0.2126, 0.7152, 0.0722));
  return mix(compressed, vec3<f32>(luma), desaturation * clamp(luma - startCompression, 0.0, 1.0));
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let sample : vec3<f32> = textureSample(hdr, samp, in.uv).rgb;
  let exposed : vec3<f32> = sample * params.exposure;
  var mapped : vec3<f32>;
  switch (params.mode) {
    case 2u: { mapped = tonemapLinear(exposed); }
    case 3u: { mapped = tonemapCineon(exposed); }
    case 4u: { mapped = tonemapAcesFilmic(exposed); }
    case 5u: { mapped = tonemapAgx(exposed); }
    case 6u: { mapped = tonemapNeutral(exposed); }
    default: { mapped = tonemapReinhardExtended(exposed); }
  }
  return vec4<f32>(mapped, 1.0);
}
