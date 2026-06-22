#define_import_path forgeax_pbr::ibl_irradiance

// @forgeax/engine-shader - ibl-irradiance.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t44).
//
// Diffuse irradiance convolution. Per LearnOpenGL §6.2.2: hemisphere
// Riemann sum (sampleDelta = 0.025) integrates the env cubemap to produce
// the convolved irradiance cubemap consumed by sampleIblDiffuse() at
// runtime.
//
// @group(0) = per-face viewProj uniform.
// @group(1) = env cubemap (texture_cube<f32>) + sampler. This is the same
//             slot the prefilter module uses for its env cube, BUT because
//             round-2 keeps each ibl-* module physically separate, the WGSL
//             (group, binding) global-uniqueness rule applies per module
//             rather than across the family.
//
// Entries: cubemap_vs + irradianceConvolve_fs.

#import forgeax_pbr::ibl_shared::{PI}

struct CubemapVsIn {
  @location(0) pos: vec3<f32>,
};
struct CubemapVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

struct CubemapFaceUniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> faceUniforms: CubemapFaceUniforms;

@group(1) @binding(0) var envCube: texture_cube<f32>;
@group(1) @binding(1) var envSamplerS: sampler;

const IRRADIANCE_SAMPLE_DELTA: f32 = 0.025;

@vertex
fn cubemap_vs(in0: CubemapVsIn) -> CubemapVsOut {
  var out: CubemapVsOut;
  out.clip = faceUniforms.viewProj * vec4<f32>(in0.pos, 1.0);
  out.worldPos = in0.pos;
  return out;
}

@fragment
fn irradianceConvolve_fs(in0: CubemapVsOut) -> @location(0) vec4<f32> {
  let N = normalize(in0.worldPos);
  let up0 = select(
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0),
    abs(N.y) > 0.999,
  );
  let right = normalize(cross(up0, N));
  let up = normalize(cross(N, right));

  var irradiance = vec3<f32>(0.0);
  var nrSamples: f32 = 0.0;

  var phi: f32 = 0.0;
  while (phi < 2.0 * PI) {
    var theta: f32 = 0.0;
    while (theta < 0.5 * PI) {
      let tangentSample = vec3<f32>(
        sin(theta) * cos(phi),
        sin(theta) * sin(phi),
        cos(theta),
      );
      let sampleVec = tangentSample.x * right +
                      tangentSample.y * up +
                      tangentSample.z * N;

      let sampleColor = textureSampleLevel(
        envCube, envSamplerS, sampleVec, 0.0,
      ).rgb;
      irradiance += sampleColor * cos(theta) * sin(theta);
      nrSamples += 1.0;
      theta += IRRADIANCE_SAMPLE_DELTA;
    }
    phi += IRRADIANCE_SAMPLE_DELTA;
  }

  irradiance = PI * irradiance / max(nrSamples, 1.0);
  return vec4<f32>(irradiance, 1.0);
}
