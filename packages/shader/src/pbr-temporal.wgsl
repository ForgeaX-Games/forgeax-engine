#define_import_path forgeax_pbr::temporal

#import forgeax_view::common::{sampleMaterialTexture, packSceneTemporal}

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

fn projectPbrSceneTemporal(
  baseColorAlpha : f32,
  alphaCutoff : f32,
  baseColorTexture : texture_2d<f32>,
  baseColorSampler : sampler,
  transform : vec4<f32>,
  metadata : vec4<f32>,
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  reactive : f32,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  uv2 : vec2<f32>,
  uv3 : vec2<f32>,
  uv4 : vec2<f32>,
  uv5 : vec2<f32>,
  uv6 : vec2<f32>,
  uv7 : vec2<f32>,
) -> vec4<f32> {
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
  let baseSample = sampleMaterialTexture(
    baseColorTexture,
    baseColorSampler,
    baseUv,
    metadata.zw,
  );
  if (alphaCutoff > 0.0 && baseColorAlpha * baseSample.a <= alphaCutoff) {
    discard;
  }
  return packSceneTemporal(currentClip, previousClip, reactive);
}
