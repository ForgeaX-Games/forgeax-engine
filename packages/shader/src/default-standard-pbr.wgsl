#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances, PointLight, SpotLight, pointLightsBuffer, spotLightsBuffer, shadowMap, shadowSampler}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::ibl_sampling::{sampleIblDiffuse, sampleIblSpecular}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, applyTBN}
#import forgeax_pbr::lighting_directional::{evalDirectional}
#import forgeax_pbr::lighting_punctual::{evalPoint, evalSpot, evalSpotShadowed}
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::lighting_punctual::{evalPointShadowed}
#import forgeax_view::common::{shadowParams}
#endif
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_hdrp::cluster_forward::{evaluate_cluster_lights, get_ssao_intensity}
#endif

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE

// @forgeax/engine-shader - default-standard-pbr.wgsl
// (feat-20260523-shader-template-instance-split M5 / T04).
//
// Engine-shipped default standard PBR material shader, registered under the
// reserved path identifier `forgeax::default-standard-pbr` (plan-strategy
// D-DefaultStandardPbr-Identifier + plan-strategy section 8.2). This file is
// the M5 successor to the monolithic `pbr.wgsl`; the BRDF / IBL / TBN /
// lighting helpers all live in independent ShaderModules and are pulled in
// via naga_oil #import (charter F1 grep gate -- AI users grep the #import
// header to enumerate every helper dependency in one shot).
//
// Bindings (4 BG layout slots; View + Mesh bindings inherited from
// forgeax_view::common; shadow map + comparison sampler at view BG
// @binding(3..4) per shadow-mapping feat; Skylight 7 bindings merged into
// the PBR material BGL at @binding(7..13) per D-5 round-4):
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform   (baseColor vec4
//                                                               + metallic + roughness
//                                                               + 4 channel selectors f32
//                                                               + emissive vec3 + emissiveIntensity
//                                                               + occlusionStrength = 80 B)
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
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// 14 entries fit within `device.limits.maxBindingsPerBindGroup` (default
// 1000 across all known WebGPU devices; chrome-beta + dawn confirmed via
// the runtime probe in createRenderer.ts -- requirements R-E acceptance
// gate). Adding more bindings requires raising the entry-count fixture in
// the M5-T04 acceptanceCheck readback assertion.
//
// Two-layer fail-fast for roughness=0 NaN avoidance (plan-strategy section
// 5.3 + AC-02 b/c):
//   layer 1: AssetRegistry.register fail-fast (M1 + M4 paramValues 3-tier)
//            returns 'asset-invalid-value' / 'material-param-type-mismatch'
//            before the payload reaches the GPU.
//   layer 2: shader internal `let a = max(material.roughness, 0.04); a = a * a;`
//            keeps D_GGX finite even if a producer somehow bypasses layer 1.
//
// Normal mapping (AC-05 + plan-strategy D-4): TBN basis built from
// per-vertex tangent (vec4 with handedness sign in .w) + interpolated
// world-space normal (consumed via mesh.normalMatrix from common.wgsl,
// plan-strategy D-5). RG-only tangent-space normal: sample.rg encodes
// (x,y) of the unit-length tangent normal, z is reconstructed via
// z = sqrt(1 - x^2 - y^2). Default 1x1 normal fallback texture is
// RG=(128,128) which decodes to tangent (0,0,1) -- zero perturbation when
// normalTexture is absent (host-side pipelineState.defaultNormalTextureView,
// distinct from the white fallback used by baseColor / metallicRoughness
// slots so a missing normal does not pollute the white-on-missing semantics
// of the other two slots). RG encoding also matches BC5 / RG normal maps
// and tolerates RGB normal maps (b is dropped, z is recomputed --
// equivalent for unit vectors).

struct Material {
  baseColor          : vec4<f32>,
  metallic           : f32,
  roughness          : f32,
  // Channel selectors (D-8): 4 independent f32 entries split out of the
  // legacy `channelMap : vec4<u32>`. Each value is a small integer encoded
  // as f32 in {0.0, 1.0, 2.0, 3.0} indexing into {r,g,b,a}. Default glTF 2.0
  // packing = (metallicChannel=2, roughnessChannel=1, aoChannel=0,
  // extraChannel=0). The fragment casts to u32 at the pick site -- f32 is
  // chosen so the schema entry type aligns with the 14-tuple
  // MaterialParamType numeric-run packing rule (4-byte stride, 16 B span).
  metallicChannel    : f32,
  roughnessChannel   : f32,
  aoChannel          : f32,
  extraChannel       : f32,
  // vec3 align=16 inserts 8 implicit padding bytes after extraChannel
  // (offsets 40..48) so emissive lands at offset 48; total UBO = 80 B.
  emissive           : vec3<f32>,
  emissiveIntensity  : f32,
  occlusionStrength  : f32,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

// Skylight bindings merged into the PBR material BGL
// (feat-20260520-skylight-ibl-cubemap M3 / t48 round-4 amend per D-5
// round-4 REVISED). The round-2 stand-alone group 4 Skylight BGL collided
// with WebGPU's default maxBindGroups=4 in chrome-beta and blocked pbr-pl
// pipeline-layout creation; round-4 appends the 7 Skylight entries to the
// PBR material BindGroupLayout at binding 7..13. The material BG factory
// (mergeSkylightIntoMaterialBgl in
// packages/runtime/src/ibl/skylight-bind-group.ts) extends the layout to
// 14 entries; render-system-record assembles a single merged material
// BindGroup (no extra setBindGroup(4) call). Identity (default) resources
// produce ambient = 0; with a real Skylight, ibl_sampling helpers project
// the IBL irradiance + split-sum specular into `ambient` below.
struct SkylightUniforms {
  intensity : f32,
  // The former pad0/1/2 lanes now carry the linear-space ambient `color` tint
  // (downstream integration #4). Kept as three scalars (NOT vec3<f32>) so the
  // struct stays exactly 16 B: a vec3 has 16-byte alignment in std140 and
  // would push `color` to offset 16, growing the UBO to 32 B and breaking the
  // single 16 B host store. WebGL2 / GLES 3.0 still requires the 16-byte
  // multiple (no `BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED`). Host writes
  // `[intensity, colorR, colorG, colorB]`; color defaults to white (1,1,1) so
  // the multiply is identity for intensity-only callers.
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
@group(1) @binding(14) var emissiveSampler      : sampler;
@group(1) @binding(15) var emissiveTexture      : texture_2d<f32>;
@group(1) @binding(16) var occlusionSampler     : sampler;
@group(1) @binding(17) var occlusionTexture     : texture_2d<f32>;

// feat-20260612-hdrp-ssao M7 (round 2) D-B + D-C, scope-amend-webgl2-ubo:
// SSAO sampling lives on the HDRP unified BGL @group(2) alongside the
// cluster bindings (binding 7 = ssao texture, binding 8 = sampler). The
// intensity scalar is folded into `cluster_uniform.near_far_log.w` (the
// previously-unused std140 pad lane on @binding(6)) — declaring a
// dedicated UBO at @binding(9) overflows WebGL2's
// `max_uniform_buffers_per_shader_stage = 11` budget on rhi-wgpu's
// fallback path. Disabled SSAO path binds 1x1 white at @binding(7) + the
// host writes intensity=0 into the cluster pad lane, so the synthesis
// collapses identically.
#ifdef CLUSTER_FORWARD_AVAILABLE
@group(2) @binding(7) var ssaoBlurredTexture       : texture_2d<f32>;
@group(2) @binding(8) var ssaoBlurredSampler       : sampler;
#endif

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) worldTangent : vec4<f32>,
  @location(4) @interpolate(flat) instanceIdx : u32,
  // feat-20260629-multi-uv-set-support (user decision): built-in PBR consumes
  // a single UV set only -- the engine still feeds extra UV sets to custom
  // material shaders that declare @location(6+), but the built-in PBR does not
  // declare/consume them. @location(5) stays intentionally vacant to keep
  // @location(6)/(7) byte-stable with the prior layout (CSM M5/w19).
  @location(6) ndc : vec3<f32>,  // NDC for HDRP cluster lookup (w10)
  // feat-20260609-hdrp-cluster-fragment-ggx M4.5-followup: view-space z is
  // needed by ndc_position_to_cluster (slice index uses log-z mapping that
  // takes negative view_z, NOT NDC z which is [0,1]). Earlier `in.ndc.z`
  // pass through view_z slot collapsed every fragment to slice 0, so cube
  // surfaces -- whose cluster cells were unrelated to the floor's slice 0
  // hot zone -- received zero light. Forward view_z explicitly. M5 / w19:
  // also feeds CSM cascade selection in evalDirectional.
  @location(7) viewZ : f32,
};

fn pick_channel(rgba : vec4<f32>, channelIndex : u32) -> f32 {
  // Branch-free channel pick. WGSL has no array<f32, 4>(rgba) addressable
  // helper; manual switch keeps the path uniform.
  switch (channelIndex) {
    case 0u: { return rgba.r; }
    case 1u: { return rgba.g; }
    case 2u: { return rgba.b; }
    default: { return rgba.a; }
  }
}

// Light evaluators live in forgeax_pbr::lighting_directional +
// forgeax_pbr::lighting_punctual (M5 / T02). evalDirectional consumes the
// host's view UBO + shadowMap (LO 3.1.3 slope-scaled-bias 3x3 PCF;
// feat-20260520-directional-light-shadow-mapping byte-equivalent). evalPoint
// / evalSpot share evalPunctualBody (GGX specular + Lambertian diffuse +
// KHR_lights_punctual quartic range attenuation;
// feat-20260519-light-casters-point-spot-pbr M4 / w22 byte-equivalent).
// Charter P4: spot light is a thin cone-multiplier on top of the punctual
// body, point light is the body unchanged -- no magic-value collapse.

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w4:
  // Entity world from meshes[0] — the @group(2) dynamic-offset window has
  // already been aimed at this entity's slot (render-system-record.ts:2996
  // setBindGroup(2, meshBindGroup, [i * MESH_PER_ENTITY_STRIDE])). Per-instance
  // local from instances[idx] — @group(3) is a flat per-instance buffer indexed
  // directly by instance_index (firstInstance=0, render-system-record.ts:2898).
  // Combine: entity_world * per_instance_local.
  let instanceLocal = instances[idx].localFromInstance;
  let entityWorld = meshes[0].worldFromLocal;
  let world = entityWorld * instanceLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldPos = world.xyz;
  // Normal: extract upper-left 3x3 from instance_local mat4 and left-multiply
  // the entity-level normalMatrix. normalize() absorbs uniform scale.
  // non-uniform scale is OOS-2 (D-3: uniform-scale-only per-instance normal transform).
  // WGSL: mat4x4 -> mat3x3 by taking columns 0,1,2 as vec3 (column-major).
  let instMat3 = mat3x3<f32>(
    instanceLocal[0].xyz,
    instanceLocal[1].xyz,
    instanceLocal[2].xyz,
  );
  out.worldNormal = normalize(instMat3 * (meshes[0].normalMatrix * in.normal));
  // Tangent transformed by the combined entity*instance chain as a direction
  // (w=0); .w handedness preserved for bitangent reconstruction in fragment.
  let worldTangentXyz = normalize((entityWorld * instanceLocal * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  out.worldTangent = vec4<f32>(worldTangentXyz, in.tangent.w);
  out.uv = in.uv;
  out.instanceIdx = idx;
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: the per-fragment
  // light-space position varying is gone; evalDirectional computes
  // per-cascade lightViewProj * worldPos in the fragment stage from
  // viewZ + worldPos.
  // NDC for HDRP cluster lookup (feat-20260609-hdrp-cluster-fragment-ggx M2 / w10).
  // Perspective divide on clip-space position; ndc.z retains depth-buffer value.
  let clipPos = out.clip;
  out.ndc = vec3(clipPos.xy / clipPos.w, clipPos.z / clipPos.w);
  // Standard WebGPU/GL perspective projection has clip.w = -view.z, so
  // view_z = -clip.w (negative in front of the camera). M4.5-followup:
  // ndc_position_to_cluster needs this for log-z slice mapping; passing
  // ndc.z (in [0,1]) instead made every fragment land in slice 0.
  out.viewZ = -clipPos.w;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let baseSample = textureSample(baseColorTexture, baseColorSampler, in.uv);
  let albedo = material.baseColor.rgb * baseSample.rgb;

  // feat-20260629-multi-uv-set-support (user decision): the built-in PBR
  // shader samples a single UV set (`in.uv`) only. Multi-UV consumption is a
  // custom-material concern -- a shader that wants a second UV set declares
  // @location(6) uv1 itself (see apps/hello-multi-uv multi-uv-demo.wgsl); the
  // engine feeds the extra sets via deriveVertexBufferLayout's reflection-driven
  // attribute emission. The built-in PBR opting out keeps every existing
  // single-UV material byte-identical (AC-11/AC-12 zero regression).

  // Metallic-roughness texture sampling with per-field channel selectors
  // (D-8): glTF 2.0 default layout B=metallic, G=roughness, R=occlusion is
  // encoded by the host as 4 independent f32 selectors in the merged UBO
  // (metallicChannel/roughnessChannel/aoChannel/extraChannel). Cast to u32
  // at the pick_channel call site; values stay in {0,1,2,3}.
  let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, in.uv);
  let metallic = material.metallic * pick_channel(mrSample, u32(material.metallicChannel));
  let roughnessTex = pick_channel(mrSample, u32(material.roughnessChannel));

  // Layer-2 fail-fast: shader internal clamp keeps D_GGX finite for
  // roughness=0 even if the asset somehow bypasses layer-1 register
  // fail-fast (plan-strategy section 5.3 + AC-02 (b)+(c)). Apply to the
  // material scalar prior to the channelMap-extracted texture multiplier
  // so the final roughness >= 0.04 floor is preserved (texture sample is
  // a 1.0-default white when metallicRoughnessTexture is absent, so
  // multiplying after the clamp keeps the floor intact).
  var a = max(material.roughness, 0.04);
  a = a * roughnessTex;
  a = a * a;

  // TBN basis composed via forgeax_pbr::tbn helpers; default fallback
  // (defaultNormalTextureView) RG=(128,128) -> tangent (0,0,1) -> world n
  // unchanged.
  let normSampleRg = textureSample(normalTexture, normalSampler, in.uv).rg;
  let normTangent = decodeTangentSpaceNormalRg(normSampleRg);
  let n = applyTBN(in.worldNormal, in.worldTangent, normTangent);

  let v = normalize(view.cameraPos - in.worldPos);
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);

  // Ambient (IBL) + 1 + N + N accumulation
  // (feat-20260520-skylight-ibl-cubemap M3 / t48 +
  //  feat-20260520-directional-light-shadow-mapping +
  //  feat-20260518-pbr-direct-lighting-mvp Finding 4):
  //
  //   color = ambient(IBL) + directional(shadowed) + sum(point) + sum(spot)
  //
  // When the host Skylight bind group provides default-zero resources the IBL
  // helpers sample to vec3(0) and ambient = 0, so the shader falls through to
  // direct lighting naturally (zero contribution, no branch, no #if guard).
  //
  // sampleIblDiffuse / sampleIblSpecular are imported from
  // forgeax_pbr::ibl_sampling (ibl-sampling.wgsl) and take the
  // @group(1) @binding(7..13) Skylight resources as function arguments
  // -- the runtime helper module is zero-binding so the host owns the
  // binding layout (round-4 amend: Skylight merged into material BGL).
  // `material.roughness` is the unsquared scalar; `a` above is the
  // alpha*alpha form used by direct-light D_GGX, which is wrong for the
  // split-sum mip lookup, so we re-derive the post-shader-clamp roughness
  // here (matches sampleIblSpecular's `mip = roughness * 4.0` expectation).
  //
  // Direct lights (1 + N + N): one directional + N point + N spot, summed
  // sequentially. LIGHT_ARRAY_MAX_SLOTS = 4 host-side bounds the loop trip
  // counts. GGX BRDF helpers (d_ggx / v_smith / f_schlick from
  // forgeax_pbr::brdf) run inside each evalDirectional / evalPoint / evalSpot
  // so all three light types share the same microfacet specular + Lambertian
  // diffuse form. The directional path additionally projects worldPos
  // through the per-cascade light-space matrix in the fragment stage for
  // shadow-map PCF lookup (CSM, feat-20260613).
  let kD = (vec3<f32>(1.0) - f_schlick(max(dot(n, v), 0.0), f0)) * (1.0 - metallic);
  let iblRoughness = max(material.roughness, 0.04) * roughnessTex;
  let irradiance = sampleIblDiffuse(n, irradianceMap, irradianceSampler);
  let specularIbl = sampleIblSpecular(
    n, v, iblRoughness, f0,
    prefilterMap, prefilterSampler, brdfLut, brdfLutSampler,
  );
  let aoSample = textureSample(occlusionTexture, occlusionSampler, in.uv);
  let ao = mix(1.0, aoSample.r, material.occlusionStrength);
  // feat-20260612-hdrp-ssao M7 round-2: `var` (mutable) so the
  // CLUSTER_FORWARD_AVAILABLE branch below can `ambient *=` the SSAO
  // factor. The non-HDRP path leaves ambient untouched.
  let skyColor = vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB);
  var ambient = (kD * irradiance * albedo + specularIbl) * skyColor * skylight.intensity * ao;
#ifdef CLUSTER_FORWARD_AVAILABLE
  // feat-20260612-hdrp-ssao M2 round-1 + M7 round-2 (plan-strategy D-7 + D-B + D-C):
  // SSAO ambient synthesis. Reads the half-res R8 `ssaoBlurredTexture` from
  // the ssao-blur pass (HDRP unified BGL @group(2) @binding(7..9)). The host
  // always binds those slots: when SSAO is disabled, binding 7 receives a
  // 1x1 white fallback (AO=1.0) and binding 9 receives a zero-intensity
  // uniform — `mix(1.0, ssao*ao, 0.0) = 1.0` so ambient collapses to the
  // round-1 baseline (no PSO recompile across the toggle).
  //
  // Sampling uses the screen-space NDC -> [0,1] uv; we recover it from the
  // clip-space xy that the vertex stage already emits via in.ndc.xy.
  let ssaoUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  let ssaoFactor = textureSample(ssaoBlurredTexture, ssaoBlurredSampler, ssaoUv).r;
  // scope-amend-webgl2-ubo: intensity packed into cluster_uniform.near_far_log.w.
  let ssaoIntensity = get_ssao_intensity();
  ambient *= mix(1.0, ssaoFactor * ao, ssaoIntensity);
#endif
  var color = ambient;
  color = color + evalDirectional(n, v, albedo, metallic, a, f0, in.worldPos, in.viewZ);
#ifdef CLUSTER_FORWARD_AVAILABLE
  // NDC from vertex shader (perspective-divided clip-space, interpolated).
  // view_z: NDC depth for cluster Z-slice lookup.
  color = color + evaluate_cluster_lights(in.ndc, in.viewZ, in.worldPos, n, v, albedo, metallic, a);
#else
  let pointCount = pointLightsBuffer.count;
  for (var i: u32 = 0u; i < pointCount; i = i + 1u) {
    let p = pointLightsBuffer.slots[i];
#ifdef POINT_SHADOW_AVAILABLE
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: gate between
    // shadowed and unshadowed evaluation on the host-assigned
    // shadowAtlasLayer (>= 0 means PointLightShadow companion exists; -1
    // sentinel means no shadow). shadowParams[layer] = (near, far,
    // 1/(far-near), 0) is bound at @group(0) @binding(6) (shadowParams
    // declared in common.wgsl).
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
    // feat-20260625-spot-light-shadow-mapping M3 / w15 (plan-strategy D-1
    // fragment side + D-3 + D-4): gate on the host-assigned shadowAtlasTile
    // (>= 0 means a spot atlas tile was allocated; -1 sentinel means no
    // shadow / clipped / direction-degenerate). The shadowed path reads the
    // per-spot perspective matrix from the View UBO `view.spotLightViewProj`
    // array (lane N = shadowAtlasTile N; folded from the standalone binding 9
    // into the View UBO in feat-20260625 w25 for WebGL2 uniform-buffer budget);
    // the unshadowed path stays on evalSpot. bias hardcoded 0.005 / 0.05 aligns
    // with the DirectionalLight defaults (D-6); the OOB/NaN gate lives inside
    // evalSpotShadowed, not here.
    if (s.shadowAtlasTile >= 0) {
      color = color + evalSpotShadowed(
        s.position, s.direction, s.colorTimesIntensity,
        s.cosInner, s.cosOuter, s.invRangeSquared,
        in.worldPos, n, v, albedo, metallic, a, f0,
        view.spotLightViewProj[s.shadowAtlasTile], s.shadowAtlasTile, 0.005, 0.05,
      );
    } else {
      color = color + evalSpot(
        s.position, s.direction, s.colorTimesIntensity,
        s.cosInner, s.cosOuter, s.invRangeSquared,
        in.worldPos, n, v, albedo, metallic, a, f0,
      );
    }
  }
#endif // CLUSTER_FORWARD_AVAILABLE
  let emissiveSample = textureSample(emissiveTexture, emissiveSampler, in.uv).rgb;
  color = color + material.emissive * material.emissiveIntensity * emissiveSample;
  return vec4<f32>(color, material.baseColor.a * baseSample.a);
}

// ── G-buffer output struct (feat-20260612-hdrp-deferred-shading M2 / w12) ──
//
// D-8: g-buffer fragment lives in default-standard-pbr as an additional entry
// point (`fs_gbuffer`), NOT a separate MaterialShader. This aligns with D-1
// (concept count compression — no new shader id for the same material).
//
// D-2 / requirements §3.2 g-buffer schema:
//   @location(0) RT0 = normal.rgb + roughness.a → rgba16f
//   @location(1) RT1 = albedo.rgb + metallic.a → rgba8unorm
//   @location(2) RT2 = emissive.rgb + ao.a → rgba16f

struct GBufferOutput {
  @location(0) normal_roughness : vec4<f32>,
  @location(1) albedo_metallic  : vec4<f32>,
  @location(2) emissive_ao      : vec4<f32>,
};

/// Deferred g-buffer fragment entry: writes material properties (normal,
/// albedo, roughness, metallic, emissive, ao) to a 3-RT g-buffer for the
/// deferred lighting pass to decode. Lighting evaluation is deferred — this
/// entry does NOT compute GGX / directional / cluster lights.
///
/// Shares the same vertex shader `vs_main` and the same material UBO / texture
/// bindings as `fs_main`; only the fragment output differs. The HDRP
/// pipeline's g-buffer render pass binds this entry point via the shader's
/// multi-entry support (passKind='deferred' selects `fs_gbuffer`).
@fragment
fn fs_gbuffer(in : VsOut) -> GBufferOutput {
  let baseSample = textureSample(baseColorTexture, baseColorSampler, in.uv);
  let albedo = material.baseColor.rgb * baseSample.rgb;

  let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, in.uv);
  let metallic = material.metallic * pick_channel(mrSample, u32(material.metallicChannel));
  let roughnessTex = pick_channel(mrSample, u32(material.roughnessChannel));

  var a = max(material.roughness, 0.04);
  a = a * roughnessTex;

  let normSampleRg = textureSample(normalTexture, normalSampler, in.uv).rg;
  let normTangent = decodeTangentSpaceNormalRg(normSampleRg);
  let n = applyTBN(in.worldNormal, in.worldTangent, normTangent);

  let emissiveSample = textureSample(emissiveTexture, emissiveSampler, in.uv).rgb;
  let emissive = material.emissive * material.emissiveIntensity * emissiveSample;

  let aoSample = textureSample(occlusionTexture, occlusionSampler, in.uv);
  let ao = mix(1.0, aoSample.r, material.occlusionStrength);

  var out : GBufferOutput;
  out.normal_roughness = vec4<f32>(n * 0.5 + 0.5, a);
  out.albedo_metallic  = vec4<f32>(albedo, metallic);
  out.emissive_ao      = vec4<f32>(emissive, ao);
  return out;
}
