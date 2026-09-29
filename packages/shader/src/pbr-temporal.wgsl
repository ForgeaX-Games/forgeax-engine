#define_import_path forgeax_pbr::temporal

#import forgeax_view::common::{sampleMaterialTexture}
#import forgeax_scene_temporal::{packSceneTemporalV1WithValidity}
#import forgeax_material::alpha_hash::{applyAlphaHash}

fn transformedPbrTemporalUv(
  transform : vec4<f32>,
  metadata : vec4<f32>,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  uv2 : vec2<f32>,
  uv3 : vec2<f32>,
  uv4 : vec2<f32>,
  uv5 : vec2<f32>,
  uv6 : vec2<f32>,
  uv7 : vec2<f32>,
) -> vec2<f32> {
  var source = uv0;
  if (metadata.x >= 1.0) { source = uv1; }
  if (metadata.x >= 2.0) { source = uv2; }
  if (metadata.x >= 3.0) { source = uv3; }
  if (metadata.x >= 4.0) { source = uv4; }
  if (metadata.x >= 5.0) { source = uv5; }
  if (metadata.x >= 6.0) { source = uv6; }
  if (metadata.x >= 7.0) { source = uv7; }
  let scaled = source * transform.zw;
  let angle = metadata.y;
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c) + transform.xy;
}

fn resolvePbrTemporalReactive(
  reactive : f32,
  baseColorAlpha : f32,
  sampledAlpha : f32,
) -> f32 {
  let coverage = clamp(baseColorAlpha * sampledAlpha, 0.0, 1.0);
  let coverageReactive = 1.0 - coverage;
  return max(clamp(reactive, 0.0, 1.0), coverageReactive);
}

fn projectPbrSceneTemporal(
  baseColorAlpha : f32,
  alphaCutoff : f32,
  alphaHash : f32,
  positionOS : vec3<f32>,
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  baseColorTextureEnabled : bool,
  baseColorTexture : texture_2d<f32>,
  baseColorSampler : sampler,
  transform : vec4<f32>,
  metadata : vec4<f32>,
#endif
#ifdef ALPHA_TEXTURE_AVAILABLE
  alphaTextureEnabled : bool,
  alphaTexture : texture_2d<f32>,
  alphaSampler : sampler,
  alphaTransform : vec4<f32>,
  alphaMetadata : vec4<f32>,
  alphaChannel : f32,
#endif
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  temporalProjection : vec4<f32>,
  reactive : f32,
  motionValid : bool,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  uv2 : vec2<f32>,
  uv3 : vec2<f32>,
  uv4 : vec2<f32>,
  uv5 : vec2<f32>,
  uv6 : vec2<f32>,
  uv7 : vec2<f32>,
) -> vec4<f32> {
  var baseSample = vec4<f32>(1.0);
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  if (baseColorTextureEnabled) {
  let baseUv = transformedPbrTemporalUv(
    transform,
    metadata,
    uv0,
    uv1,
    uv2,
    uv3,
    uv4,
    uv5,
    uv6,
    uv7,
  );
  baseSample = sampleMaterialTexture(
    baseColorTexture,
    baseColorSampler,
    baseUv,
    metadata.zw,
  );
  }
#endif
  var alphaSample = 1.0;
#ifdef ALPHA_TEXTURE_AVAILABLE
  if (alphaTextureEnabled) {
    let alphaUv = transformedPbrTemporalUv(
      alphaTransform, alphaMetadata, uv0, uv1, uv2, uv3, uv4, uv5, uv6, uv7,
    );
    let texel = sampleMaterialTexture(alphaTexture, alphaSampler, alphaUv, alphaMetadata.zw);
    switch (u32(alphaChannel)) {
      case 0u: { alphaSample = texel.r; }
      case 1u: { alphaSample = texel.g; }
      case 2u: { alphaSample = texel.b; }
      default: { alphaSample = texel.a; }
    }
  }
#endif
  let coverage = baseColorAlpha * baseSample.a * alphaSample;
  applyAlphaHash(coverage, positionOS, alphaHash);
  if (alphaCutoff > 0.0 && coverage <= alphaCutoff) {
    discard;
  }
  let reactiveCoverage = select(resolvePbrTemporalReactive(reactive, coverage, 1.0), reactive, alphaHash > 0.5);
  return packSceneTemporalV1WithValidity(
    currentClip,
    previousClip,
    temporalProjection,
    reactiveCoverage,
    motionValid,
  );
}
