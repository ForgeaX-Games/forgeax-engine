#define_import_path forgeax_material::default_standard_surface

#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::surface_sampling::{sampleSurfaceTexture, surfaceTextureFootprint}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN, perturbBumpNormal}
#ifdef ALPHA_HASH_AVAILABLE
#import forgeax_material::alpha_hash::{applyAlphaHash}
#endif

// The default Surface owns only base facts. Standard's generated Material
// interface remains the source of the scalar and texture values; the
// Standard template owns physical-layer selection and lighting.
fn surfaceUv(input : SurfaceInput, transform : vec4<f32>, metadata : vec4<f32>) -> vec2<f32> {
  var source = input.uv0;
  if (metadata.x >= 1.0) { source = input.uv1; }
  if (metadata.x >= 2.0) { source = input.uv2; }
  if (metadata.x >= 3.0) { source = input.uv3; }
  if (metadata.x >= 4.0) { source = input.uv4; }
  if (metadata.x >= 5.0) { source = input.uv5; }
  if (metadata.x >= 6.0) { source = input.uv6; }
  if (metadata.x >= 7.0) { source = input.uv7; }
  let scaled = source * transform.zw;
  let c = cos(metadata.y);
  let s = sin(metadata.y);
  return vec2<f32>(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c) + transform.xy;
}

fn surfaceChannel(value : vec4<f32>, channel : u32) -> f32 {
  switch (channel) {
    case 0u: { return value.r; }
    case 1u: { return value.g; }
    case 2u: { return value.b; }
    default: { return value.a; }
  }
}

fn evaluate_standard_surface(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceData {
  var baseSample = vec4<f32>(1.0);
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  if (standardUsesBaseColorTexture()) {
  baseSample = sampleSurfaceTexture(
    baseColorTexture,
    baseColorTexture_sampler,
    surfaceUv(input, materialValue.baseColorTextureCoordinatesTransform, materialValue.baseColorTextureCoordinatesMetadata) * materialValue.baseColorTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.baseColorTextureCoordinatesTransform, materialValue.baseColorTextureCoordinatesMetadata),
  );
  }
#endif
  var metallicRoughnessSample = vec4<f32>(1.0);
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesMetallicRoughnessTexture()) {
  metallicRoughnessSample = sampleSurfaceTexture(
    metallicRoughnessTexture,
    metallicRoughnessTexture_sampler,
    surfaceUv(input, materialValue.metallicRoughnessTextureCoordinatesTransform, materialValue.metallicRoughnessTextureCoordinatesMetadata) * materialValue.metallicRoughnessTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.metallicRoughnessTextureCoordinatesTransform, materialValue.metallicRoughnessTextureCoordinatesMetadata),
  );
  }
#endif
  // Each independent map replaces only its packed source. Scalar factors
  // still multiply the selected texel, and missing maps remain neutral.
  var metallicSample = metallicRoughnessSample;
  var roughnessSample = metallicRoughnessSample;
  var alpha = 1.0;
#ifdef METALLIC_TEXTURE_AVAILABLE
  if (standardUsesMetallicTexture()) {
    if (standardReusesMetallicTextureFromBaseColorTexture()) {
      metallicSample = baseSample;
    } else if (standardReusesMetallicTextureFromMetallicRoughnessTexture()) {
      metallicSample = metallicRoughnessSample;
    } else {
      metallicSample = sampleSurfaceTexture(
        metallicTexture,
        metallicTexture_sampler,
        surfaceUv(input, materialValue.metallicTextureCoordinatesTransform, materialValue.metallicTextureCoordinatesMetadata) * materialValue.metallicTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.metallicTextureCoordinatesTransform, materialValue.metallicTextureCoordinatesMetadata),
      );
    }
  }
#endif
#ifdef ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesRoughnessTexture()) {
    if (standardReusesRoughnessTextureFromBaseColorTexture()) {
      roughnessSample = baseSample;
    } else if (standardReusesRoughnessTextureFromMetallicRoughnessTexture()) {
      roughnessSample = metallicRoughnessSample;
    } else if (standardReusesRoughnessTextureFromMetallicTexture()) {
      roughnessSample = metallicSample;
    } else {
      roughnessSample = sampleSurfaceTexture(
        roughnessTexture,
        roughnessTexture_sampler,
        surfaceUv(input, materialValue.roughnessTextureCoordinatesTransform, materialValue.roughnessTextureCoordinatesMetadata) * materialValue.roughnessTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.roughnessTextureCoordinatesTransform, materialValue.roughnessTextureCoordinatesMetadata),
      );
    }
  }
#endif
#ifdef ALPHA_TEXTURE_AVAILABLE
  if (standardUsesAlphaTexture()) {
    var alphaSample = vec4<f32>(1.0);
    if (standardReusesAlphaTextureFromBaseColorTexture()) {
      alphaSample = baseSample;
    } else if (standardReusesAlphaTextureFromMetallicRoughnessTexture()) {
      alphaSample = metallicRoughnessSample;
    } else if (standardReusesAlphaTextureFromMetallicTexture()) {
      alphaSample = metallicSample;
    } else if (standardReusesAlphaTextureFromRoughnessTexture()) {
      alphaSample = roughnessSample;
    } else {
      alphaSample = sampleSurfaceTexture(
        alphaTexture,
        alphaTexture_sampler,
        surfaceUv(input, materialValue.alphaTextureCoordinatesTransform, materialValue.alphaTextureCoordinatesMetadata) * materialValue.alphaTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.alphaTextureCoordinatesTransform, materialValue.alphaTextureCoordinatesMetadata),
      );
    }
    alpha = surfaceChannel(alphaSample, u32(materialValue.alphaChannel));
  }
#endif
  let faceDirection = select(-1.0, 1.0, input.frontFacing);
  var normal = normalize(input.vertexNormalWS) * faceDirection;
  var usesNormal = false;
#ifdef NORMAL_TEXTURE_AVAILABLE
  if (standardUsesNormalTexture()) {
  let normalSample = sampleSurfaceTexture(
    normalTexture,
    normalTexture_sampler,
    surfaceUv(input, materialValue.normalTextureCoordinatesTransform, materialValue.normalTextureCoordinatesMetadata) * materialValue.normalTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.normalTextureCoordinatesTransform, materialValue.normalTextureCoordinatesMetadata),
  );
  normal = applyTBN(input.vertexNormalWS, input.tangentWS,
    scaleTangentSpaceNormal(decodeTangentSpaceNormalRg(normalSample.rg), materialValue.normalScale)) * faceDirection;
  usesNormal = true;
  }
#endif
#ifdef BUMP_TEXTURE_AVAILABLE
  if (!usesNormal && standardUsesBumpTexture()) {
    let uv = surfaceUv(input, materialValue.bumpTextureCoordinatesTransform, materialValue.bumpTextureCoordinatesMetadata) * materialValue.bumpTextureCoordinatesMetadata.zw;
    let dx = dpdx(uv);
    let dy = dpdy(uv);
    let height = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv, dx, dy).r;
    let heightX = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dx, dx, dy).r;
    let heightY = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dy, dx, dy).r;
    normal = perturbBumpNormal(input.positionWS, normal,
      materialValue.bumpScale * vec2<f32>(heightX - height, heightY - height), faceDirection);
  }
#endif
  var emissiveSample = vec4<f32>(1.0);
#ifdef EMISSIVE_TEXTURE_AVAILABLE
  if (standardUsesEmissiveTexture()) {
  emissiveSample = sampleSurfaceTexture(
    emissiveTexture,
    emissiveTexture_sampler,
    surfaceUv(input, materialValue.emissiveTextureCoordinatesTransform, materialValue.emissiveTextureCoordinatesMetadata) * materialValue.emissiveTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.emissiveTextureCoordinatesTransform, materialValue.emissiveTextureCoordinatesMetadata),
  );
  }
#endif
  var occlusionSample = vec4<f32>(1.0);
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  if (standardUsesOcclusionTexture()) {
  occlusionSample = sampleSurfaceTexture(
    occlusionTexture,
    occlusionTexture_sampler,
    surfaceUv(input, materialValue.occlusionTextureCoordinatesTransform, materialValue.occlusionTextureCoordinatesMetadata) * materialValue.occlusionTextureCoordinatesMetadata.zw,
    surfaceTextureFootprint(input, materialValue.occlusionTextureCoordinatesTransform, materialValue.occlusionTextureCoordinatesMetadata),
  );
  }
#endif
  let vertexColor = input.vertexColor;
  let baseColor = materialValue.baseColor.rgb * baseSample.rgb * vertexColor.rgb;
  let metallic = clamp(
    materialValue.metallic * surfaceChannel(metallicSample, u32(materialValue.metallicChannel)),
    0.0,
    1.0,
  );
  let roughness = clamp(
    materialValue.roughness * surfaceChannel(roughnessSample, u32(materialValue.roughnessChannel)),
    0.04,
    1.0,
  );
  let emissive = materialValue.emissive * materialValue.emissiveIntensity * emissiveSample.rgb;
  let occlusion = clamp(
    1.0 + (occlusionSample.r - 1.0) * materialValue.occlusionStrength,
    0.0,
    1.0,
  );
#ifdef ALPHA_HASH_AVAILABLE
  applyAlphaHash(materialValue.baseColor.a * baseSample.a * vertexColor.a * alpha, input.positionOS, materialValue.alphaHash);
#endif
  return SurfaceData(
    baseColor,
    normal,
    metallic,
    roughness,
    emissive,
    occlusion,
    clamp(materialValue.baseColor.a * baseSample.a * vertexColor.a * alpha, 0.0, 1.0),
    clamp(materialValue.alphaCutoff, 0.0, 1.0),
  );
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  return evaluate_standard_surface(input, material);
}
