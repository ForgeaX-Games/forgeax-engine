#define_import_path forgeax_environment::cubemap

// @forgeax/engine-shader - atmosphere-cubemap.wgsl
//
// The sole production caller of preetham_sky_radiance. Background and IBL
// consumers sample this generated cube; neither owns another evaluator.

#import forgeax_environment::preetham::{preetham_sky_radiance}

struct AtmosphereCubeParams {
  sunDirection: vec3<f32>,
  sunIlluminance: f32,
  sunColor: vec3<f32>,
  _sunColorPad: f32,
  turbidity: f32,
  rayleigh: f32,
  mieCoefficient: f32,
  mieDirectionalG: f32,
  sunAngularRadius: f32,
  sunDiscEnabled: f32,
  _tailPad: vec2<f32>,
};

struct AtmosphereCubeVsIn {
  // xy is clip-space; z is a one-based cube-face tag supplied by the
  // producer's six fullscreen triangles.
  @location(0) faceVertex: vec3<f32>,
};

struct AtmosphereCubeVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereCubeParams;

@vertex
fn atmosphere_cubemap_vs(input: AtmosphereCubeVsIn) -> AtmosphereCubeVsOut {
  var output: AtmosphereCubeVsOut;
  let face = u32(input.faceVertex.z) - 1u;
  let x = input.faceVertex.x;
  let y = input.faceVertex.y;
  output.clip = vec4<f32>(x, y, 0.5, 1.0);
  switch face {
    case 0u: { output.direction = vec3<f32>(1.0, -y, -x); }
    case 1u: { output.direction = vec3<f32>(-1.0, -y, x); }
    // Cube consumers negate Y for the shared OpenGL-authored convention.
    // Clip-space Y is also inverted by the attachment viewport. The four
    // side faces already compose both transforms through `-y`; the Y-axis
    // faces must encode their world sign and Z orientation explicitly.
    case 2u: { output.direction = vec3<f32>(x, -1.0, -y); }
    case 3u: { output.direction = vec3<f32>(x, 1.0, y); }
    case 4u: { output.direction = vec3<f32>(x, -y, 1.0); }
    default: { output.direction = vec3<f32>(-x, -y, -1.0); }
  }
  return output;
}

@fragment
fn atmosphere_cubemap_fs(input: AtmosphereCubeVsOut) -> @location(0) vec4<f32> {
  let radiance = preetham_sky_radiance(
    normalize(input.direction),
    atmosphere.sunDirection,
    atmosphere.sunColor,
    atmosphere.sunIlluminance,
    atmosphere.turbidity,
    atmosphere.rayleigh,
    atmosphere.mieCoefficient,
    atmosphere.mieDirectionalG,
  );
  return vec4<f32>(radiance, 1.0);
}
