#define_import_path forgeax_pbr::ibl_sampling

// @forgeax/engine-shader - ibl-sampling.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t47).
//
// Runtime IBL sampling helpers consumed by pbr.wgsl. Each helper takes the
// texture + sampler as function arguments rather than declaring its own
// @group/@binding, so the host (pbr.wgsl's @group(1) material BGL,
// Skylight resources at @binding(7..13) per D-5 round-4) owns the
// binding layout and this module composes cleanly anywhere.
//
// Zero @group/@binding declarations -- this is the symmetric counterpart
// to ibl-shared.wgsl for runtime sampling code.
//
// Exports:
//   - sampleIblDiffuse(N, irradianceMap, irradianceSampler)
//   - sampleIblSpecular(N, V, roughness, F0, prefilterMap, prefilterSampler,
//                       brdfLut, brdfLutSampler)

#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness}

// Sample pre-convolved irradiance from the irradiance cubemap.
// Y is negated to compensate for WebGPU's top-left texture origin vs the
// OpenGL convention used during equirect-to-cube render passes.
fn sampleIblDiffuse(
  normal: vec3<f32>,
  irradianceMap: texture_cube<f32>,
  irradianceSampler: sampler,
) -> vec3<f32> {
  let dir = vec3<f32>(normal.x, -normal.y, normal.z);
  return textureSample(irradianceMap, irradianceSampler, dir).rgb;
}

// Split-sum specular IBL: prefiltered env * (F0 * scale + bias).
fn sampleIblSpecular(
  normal: vec3<f32>,
  view: vec3<f32>,
  roughness: f32,
  F0: vec3<f32>,
  prefilterMap: texture_cube<f32>,
  prefilterSampler: sampler,
  brdfLut: texture_2d<f32>,
  brdfLutSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  let R = reflect(-view, normal);
  let Rflip = vec3<f32>(R.x, -R.y, R.z);
  let mip = roughness * 4.0;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, Rflip, mip).rgb;
  let envBRDF = textureSample(brdfLut, brdfLutSampler, vec2<f32>(NdotV, roughness)).rg;
  let F = fresnelSchlickRoughness(NdotV, F0, roughness);
  return prefilteredColor * (F * envBRDF.r + envBRDF.g);
}
