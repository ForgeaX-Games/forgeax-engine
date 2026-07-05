#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances, PointLight, SpotLight, pointLightsBuffer, spotLightsBuffer, shadowMap, shadowSampler}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::ibl_sampling::{sampleIblDiffuse, sampleIblSpecular}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, applyTBN}
#import forgeax_pbr::lighting_directional::{evalDirectional}
#import forgeax_pbr::lighting_punctual::{evalPoint, evalSpot}
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::lighting_punctual::{evalPointShadowed}
#import forgeax_view::common::{shadowParams}
#endif

#pragma variant_axis STORAGE_BUFFER_AVAILABLE

// @forgeax/engine-shader - default-standard-pbr-skin.wgsl
// (feat-20260523-skin-skeleton-animation M3 / T-29).
//
// Engine-shipped default standard PBR material shader with GPU skinning,
// registered under the reserved path identifier `forgeax::pbr-skin`
// (plan-strategy D-3). Fragment stage is byte-for-byte identical to
// default-standard-pbr.wgsl — the two shaders share the same PBR/IBL/TBN/
// lighting helpers via #import. The vertex stage adds 4-bone weighted
// skinning before the worldFromLocal transform.
//
// Bindings (4 BG layout slots; @group(0) View / @group(1) Material+Texture
// / @group(2) Meshes+Palette — identical to default-standard-pbr except
// @group(2)@binding(1) adds the skin palette storage buffer):
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform
//   @group(1) @binding(1) baseColorSampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(1) @binding(3) metallicRoughnessSampler   sampler
//   @group(1) @binding(4) metallicRoughnessTexture   texture_2d<f32>
//   @group(1) @binding(5) normalSampler              sampler
//   @group(1) @binding(6) normalTexture              texture_2d<f32>
//   @group(1) @binding(7..13) Skylight (irradiance / prefilter / brdfLut +
//                              samplers) + skylight uniform (intensity)
//   @group(2) @binding(0) meshes                     storage   (worldFromLocal mat4
//                                                               + normalMatrix mat3,
//                                                               see common.wgsl)
//   @group(2) @binding(1) palette                    storage   (array of joint
//                                                               skinning mat4x4,
//                                                               CPU-precomputed
//                                                               world * IBM)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance
//                                                               mat4; see
//                                                               common.wgsl —
//                                                               preventive
//                                                               structural
//                                                               alignment:
//                                                               SkinInstances-
//                                                               CoexistForbidden
//                                                               blocks skin +
//                                                               instances, so
//                                                               instances[idx]
//                                                               = I identity)
//
// Skinning formula (plan-strategy D-3 / D-3a):
//   world_pos  = Sum(w_i * palette[base + skinIndex[i]] * local_pos)
//   world_norm = transpose(inverse(mat3x3(skin_matrix))) * local_normal
// 4 joints max; weighted sum of skinned positions from the palette buffer
// indexed by the per-vertex skinIndex vector.

struct Material {
  baseColor          : vec4<f32>,
  metallic           : f32,
  roughness          : f32,
  // Channel selectors (D-8): 4 independent f32 entries split out of the
  // legacy `channelMap : vec4<u32>`. See default-standard-pbr.wgsl for
  // the full rationale; the skin shader shares the same merged UBO shape.
  metallicChannel    : f32,
  roughnessChannel   : f32,
  aoChannel          : f32,
  extraChannel       : f32,
  // vec3 align=16 inserts implicit padding so emissive lands at offset 48;
  // total UBO = 80 B (matches default-standard-pbr SSOT).
  emissive           : vec3<f32>,
  emissiveIntensity  : f32,
  occlusionStrength  : f32,
  // feat-city-glb multi-UV tiling: per-material UV-set selector (mirrors
  // default-standard-pbr.wgsl SSOT). 0.0 -> set 0 (in.uv), >=0.5 -> set 1
  // (in.uv1). Offset 68; struct still rounds to 80 B.
  uvSet              : f32,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

struct SkylightUniforms {
  intensity : f32,
  // 16 B (WebGL2 / GLES 3.0 uniform-buffer 16-byte-multiple rule). The former
  // pad0/1/2 lanes now carry the linear-space ambient `color` tint
  // (downstream integration #4). Kept as three scalars (NOT vec3<f32>) so the
  // struct stays exactly 16 B -- a vec3 has 16-byte std140 alignment and would
  // grow the UBO to 32 B. Host writes `[intensity, colorR, colorG, colorB]`;
  // color defaults to white so the multiply is identity for intensity-only
  // callers.
  colorR : f32,
  colorG : f32,
  colorB : f32,
};
@group(1) @binding(7)  var irradianceMap        : texture_cube<f32>;
@group(1) @binding(8)  var irradianceSampler    : sampler;
@group(1) @binding(9)  var prefilterMap         : texture_cube<f32>;
@group(1) @binding(10) var prefilterSampler     : sampler;
@group(1) @binding(11) var brdfLut              : texture_2d<f32>;
@group(1) @binding(12) var brdfLutSampler       : sampler;
@group(1) @binding(13) var<uniform> skylight    : SkylightUniforms;

#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(1) var<storage, read> palette : array<mat4x4<f32>>;
#else
@group(2) @binding(1) var<uniform> palette : array<mat4x4<f32>, 255>;
#endif

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  @location(4) skinIndex  : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
  // feat-city-glb multi-UV tiling: second UV set at canonical location 6
  // (drives naga uvSetCount=2 reflection; clamp-to-last aliases onto uv0 for
  // single-UV meshes). Mirrors default-standard-pbr.wgsl.
  @location(6) uv1     : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) worldTangent : vec4<f32>,
  @location(4) @interpolate(flat) instanceIdx : u32,
  // feat-city-glb multi-UV tiling: second UV set varying at location 5
  // (parity with default-standard-pbr.wgsl).
  @location(5) uv1 : vec2<f32>,
  @location(7) viewZ : f32,
};

fn pick_channel(rgba : vec4<f32>, channelIndex : u32) -> f32 {
  switch (channelIndex) {
    case 0u: { return rgba.r; }
    case 1u: { return rgba.g; }
    case 2u: { return rgba.b; }
    default: { return rgba.a; }
  }
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // 4-bone weighted skinning (plan-strategy D-3 / D-3a).
  // The host pre-computes each joint matrix as worldFromJoint * inverseBindMatrix
  // (CPU-side pre-multiplication, per D-4) and writes them into the palette
  // storage buffer. The BindGroup dynamic offset selects the per-entity slice
  // so palette[0] is the first joint of this draw.

  // Accumulate the weighted 4-joint skinning matrix: sum(w_i * M_i).
  // Each palette entry is a mat4x4<f32> (world * IBM per joint).
  // The host sets the BindGroup dynamic offset to (byteOffset / 64) so the
  // first palette entry visible to this draw is palette[0]. The shader
  // indexes into palette directly using the per-vertex skinIndex values.
  let skinMatrix = palette[in.skinIndex.x] * in.skinWeight.x +
    palette[in.skinIndex.y] * in.skinWeight.y +
    palette[in.skinIndex.z] * in.skinWeight.z +
    palette[in.skinIndex.w] * in.skinWeight.w;

  // glTF 2.0 sec.Skins Implementation Note: when a mesh node has a skin
  // property, the joint matrices already encode the global transform of each
  // joint relative to the scene root. The transform of the mesh node itself
  // must be ignored when rendering the skinned mesh.
  //
  // The host pre-computes palette[i] = jointWorld_i * IBM_i (full world-space
  // transform, including the entire ancestor chain via propagateTransforms).
  // skinnedLocal IS the world position -- no additional left-multiply by
  // meshes[0].worldFromLocal or instanceLocal is needed.
  //
  // This removes the implicit contract "Skin entity Transform.world must be
  // identity" -- a skin entity can be parented under any Transform chain and
  // the skinned mesh will rigidly follow via joint propagation alone.
  let skinnedLocal = skinMatrix * vec4<f32>(in.pos, 1.0);

  // Extract the upper-left 3x3 for normal/tangent transformation
  // (plan-strategy D-3a). WGSL mat4x4 columns are vec4:
  //   col0 = palette[i][0], col1 = palette[i][1], col2 = palette[i][2].
  // We sum the weighted columns across the 4 joints to build the 3x3.
  let m0 = skinMatrix[0].xyz;
  let m1 = skinMatrix[1].xyz;
  let m2 = skinMatrix[2].xyz;
  let skinNormal3x3 = mat3x3<f32>(m0, m1, m2);

  // world = skinnedLocal (position), no extra left-multiply --
  // palette = jointWorld * IBM is already full world-space.
  var out : VsOut;
  // Keep meshes[0] and instances bindings referenced so naga_oil does not
  // dead-code-eliminate the @group(2)@binding(0) and @group(3)@binding(0)
  // globals. The host-side BGL shape must remain compatible with non-skin
  // PBR pipeline layout (buildPbrSkinLayouts declares 2-entry mesh-array
  // slot + separate instances slot). Without these keep-alive references,
  // createRenderPipeline would fail on binding-count mismatch.
  _ = meshes[0].worldFromLocal;
  _ = instances[0].localFromInstance;
  out.clip = view.worldViewProj * skinnedLocal;
  out.worldPos = skinnedLocal.xyz;
  out.worldNormal = normalize(skinNormal3x3 * in.normal);
  let worldTangentXyz = normalize(skinNormal3x3 * in.tangent.xyz);
  out.worldTangent = vec4<f32>(worldTangentXyz, in.tangent.w);
  out.uv = in.uv;
  out.uv1 = in.uv1;
  out.instanceIdx = idx;
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: viewZ replaces the
  // prior light-space-position varying; evalDirectional picks the cascade
  // matrix per fragment from viewZ + worldPos.
  out.viewZ = -out.clip.w;
  return out;
}

// feat-city-glb multi-UV tiling: mirror of default-standard-pbr.wgsl selectUv.
fn selectUv(in : VsOut) -> vec2<f32> {
  return select(in.uv, in.uv1, material.uvSet >= 0.5);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let uv = selectUv(in);
  let baseSample = textureSample(baseColorTexture, baseColorSampler, uv);
  let albedo = material.baseColor.rgb * baseSample.rgb;

  let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, uv);
  let metallic = material.metallic * pick_channel(mrSample, u32(material.metallicChannel));
  let roughnessTex = pick_channel(mrSample, u32(material.roughnessChannel));

  var a = max(material.roughness, 0.04);
  a = a * roughnessTex;
  a = a * a;

  let normSampleRg = textureSample(normalTexture, normalSampler, uv).rg;
  let normTangent = decodeTangentSpaceNormalRg(normSampleRg);
  let n = applyTBN(in.worldNormal, in.worldTangent, normTangent);

  let v = normalize(view.cameraPos - in.worldPos);
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);

  let kD = (vec3<f32>(1.0) - f_schlick(max(dot(n, v), 0.0), f0)) * (1.0 - metallic);
  let iblRoughness = max(material.roughness, 0.04) * roughnessTex;
  let irradiance = sampleIblDiffuse(n, irradianceMap, irradianceSampler);
  let specularIbl = sampleIblSpecular(
    n, v, iblRoughness, f0,
    prefilterMap, prefilterSampler, brdfLut, brdfLutSampler,
  );
  let skyColor = vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB);
  let ambient = (kD * irradiance * albedo + specularIbl) * skyColor * skylight.intensity;
  var color = ambient;
  color = color + evalDirectional(n, v, albedo, metallic, a, f0, in.worldPos, in.viewZ);
  let pointCount = pointLightsBuffer.count;
  for (var i: u32 = 0u; i < pointCount; i = i + 1u) {
    let p = pointLightsBuffer.slots[i];
#ifdef POINT_SHADOW_AVAILABLE
    if (p.shadowAtlasLayer >= 0) {
      let lane = shadowParams[p.shadowAtlasLayer];
      color = color + evalPointShadowed(
        p.position, p.colorTimesIntensity, p.invRangeSquared,
        in.worldPos, n, v, albedo, metallic, a, f0,
        p.shadowAtlasLayer, lane.x, lane.y, 0.005, 0.05,
      );
    } else {
      color = color + evalPoint(
        p.position, p.colorTimesIntensity, p.invRangeSquared,
        in.worldPos, n, v, albedo, metallic, a, f0,
      );
    }
#else
    color = color + evalPoint(
      p.position, p.colorTimesIntensity, p.invRangeSquared,
      in.worldPos, n, v, albedo, metallic, a, f0,
    );
#endif
  }
  let spotCount = spotLightsBuffer.count;
  for (var i: u32 = 0u; i < spotCount; i = i + 1u) {
    let s = spotLightsBuffer.slots[i];
    color = color + evalSpot(
      s.position, s.direction, s.colorTimesIntensity,
      s.cosInner, s.cosOuter, s.invRangeSquared,
      in.worldPos, n, v, albedo, metallic, a, f0,
    );
  }
  return vec4<f32>(color, material.baseColor.a * baseSample.a);
}