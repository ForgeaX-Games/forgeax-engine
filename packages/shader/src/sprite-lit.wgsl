#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#define_import_path forgeax_material::sprite-lit

#import forgeax_view::common::{View, FogViewParams, FogRay, Mesh, InstanceData, PointLight, SpotLight, view, meshes, instances, pointLightsBuffer, spotLightsBuffer, sampleMaterialTexture, packSceneTemporal}
#import forgeax_view::fog::{apply_fog}

// @forgeax/engine-shader - sprite-lit.wgsl
// (tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d).
//
// Parallel 4th sprite shading model (alongside forgeax::sprite / unlit /
// pbr-standard). Lights a 2D sprite quad with the 3 punctual light kinds
// (DirectionalLight + PointLight + SpotLight) using flat 2D lighting:
// each fragment sums `albedo * lightColor * attenuation * cone` across all
// active lights. Sprites are treated as omnidirectional receivers so light
// direction and camera orientation do not affect shading, matching the
// Godot Light2D and Unity URP 2D Renderer mental model.
//
// SSOTs:
//   - requirements section 2 (in-scope items)
//   - requirements section 4 AC-01 .. AC-07
//   - plan-strategy D-P1 (VsOut carries worldPos from vertex stage)
//   - plan-strategy D-P2 (light functions drop normal parameter; flat SSOT)
//
// What this shader is NOT:
//   - no normal-map sampling
//   - no shadow receiver / caster
//   - no Godot-style light_mode blends
//   - no IBL ambient
//   - no HDRP cluster-forward path
//
// >>> AI user error self-recovery hint:
// sprite-lit needs at least one light in scene; for unlit sprites use
// forgeax::sprite (the engine ships them as parallel 4th shading model id;
// 1 string change in MaterialAsset.passes[0].shader).
//
// Bindings (byte-identical to sprite.wgsl so the 4 BindGroupLayout chain is
// reused without a per-pipeline BGL; the 4 PBR-unused entries 3..6 bind
// pipelineState.defaultSampler + .defaultWhiteTextureView on the host side):
//
//   @group(0) @binding(0) view                       uniform
//   @group(0) @binding(1) pointLightsBuffer          storage / uniform (variant)
//   @group(0) @binding(2) spotLightsBuffer           storage / uniform (variant)
//   @group(1) @binding(0) material                   uniform (sprite layout
//                                                             colorTint /
//                                                             region /
//                                                             pivotAndSize /
//                                                             slicesAndMode)
//   @group(1) @binding(1) baseColorSampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(2) @binding(0) meshes                     storage
//   @group(3) @binding(0) instances                  storage (per-instance
//                                                             localFromInstance
//                                                             mat4)

struct Material {
  // .xyz multiplies textureSample.rgb; .w multiplies textureSample.a.
  // Mirrors sprite.wgsl Material layout byte-for-byte (sprite-lit reuses
  // the same UBO writer + paramSchema entries).
  colorTint     : vec4<f32>,
  region        : vec4<f32>,
  pivotAndSize  : vec4<f32>,
  slicesAndMode : vec4<f32>,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
// Preserve filtering reflection for the bound texture passed to the helper.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let baseWitness = textureSample(base, baseColorSampler, vec2<f32>(0.0));
}

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

// VsOut carries the atlas UV plus the per-fragment world-space position.
// The world position is emitted from the vertex stage (already computed
// there for `out.clip`), so PointLight / SpotLight attenuation gets an
// exact per-fragment worldPos through interpolation. This replaces the
// earlier fragment-side reconstruction path, which collapsed under
// multi-instance draws and could not handle the 9-slice quad layout.
struct VsOut {
  @builtin(position) clip     : vec4<f32>,
  @location(0)       uv_atlas : vec2<f32>,
  @location(1)       worldPos : vec3<f32>,
};

struct SpriteVertex {
  posLocal : vec3<f32>,
  uvAtlas : vec2<f32>,
};

fn resolveSpriteVertex(in : VsIn, vertex_index : u32) -> SpriteVertex {
  // Body is the slice-aware sprite vertex stage byte-for-byte ported from
  // sprite.wgsl (feat-20260520 M-3 / w19 + feat-20260527 M3 / w15). The
  // 9-slice early-out via slicesAndMode == 0 sentinel keeps the legacy
  // single-quad path byte-identical so sprite-lit demos that do not enable
  // slicing pay zero perf for the slicing branch.
  let pivot = material.pivotAndSize.xy;
  let size  = material.pivotAndSize.zw;
  let useSlices = any(material.slicesAndMode != vec4<f32>(0.0));
  var pos_local : vec3<f32>;
  var uv_atlas : vec2<f32>;
  if (useSlices) {
    let abs_slices = abs(material.slicesAndMode);
    let is_tile = material.slicesAndMode.w < 0.0;
    let i = vertex_index % 4u;
    let j = vertex_index / 4u;
    let u_pos_arr = array<f32, 4>(0.0, abs_slices.x, 1.0 - abs_slices.z, 1.0);
    let v_pos_arr = array<f32, 4>(0.0, abs_slices.y, 1.0 - abs_slices.w, 1.0);
    let u_pos = u_pos_arr[i];
    let v_pos_top = v_pos_arr[j];
    let v_pos_eff = 1.0 - v_pos_top;
    pos_local = vec3<f32>((u_pos - pivot.x) * size.x, (v_pos_eff - pivot.y) * size.y, 0.0);
    var u_uv_arr = array<f32, 4>(0.0, abs_slices.x, 1.0 - abs_slices.z, 1.0);
    var v_uv_arr = array<f32, 4>(0.0, abs_slices.y, 1.0 - abs_slices.w, 1.0);
    if (is_tile) {
      let mid_u = 1.0 - abs_slices.x - abs_slices.z;
      let mid_v = 1.0 - abs_slices.y - abs_slices.w;
      u_uv_arr[2] = abs_slices.x + 2.0 * mid_u;
      u_uv_arr[3] = u_uv_arr[2] + abs_slices.z;
      v_uv_arr[2] = abs_slices.y + 2.0 * mid_v;
      v_uv_arr[3] = v_uv_arr[2] + abs_slices.w;
    }
    let uv_u = u_uv_arr[i];
    let uv_v_top = v_uv_arr[j];
    let uv_v_eff = 1.0 - uv_v_top;
    uv_atlas = vec2<f32>(uv_u, uv_v_eff) * material.region.zw + material.region.xy;
  } else {
    let uv_eff = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
    pos_local = vec3<f32>((uv_eff - pivot) * size, 0.0);
    uv_atlas = uv_eff * material.region.zw + material.region.xy;
  }
  var out : SpriteVertex;
  out.posLocal = pos_local;
  out.uvAtlas = uv_atlas;
  return out;
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex_index : u32) -> VsOut {
  let vertex = resolveSpriteVertex(in, vertex_index);
  // AC-11 instances path day-1: the world transform is meshes[0].worldFromLocal
  // * instances[idx].localFromInstance * vec4(pos_local, 1.0) -- same chain
  // sprite.wgsl + default-standard-pbr.wgsl use.
  let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(vertex.posLocal, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv_atlas = vertex.uvAtlas;
  out.worldPos = world.xyz;
  return out;
}

// linear_to_srgb mirrors sprite.wgsl L251-254: per-channel IEC 61966-2-1
// transfer used by the LDR fragment entry to encode the bgra8unorm swap
// chain output (the format is not hardware-sRGB-encoded; the shader does it).
fn linear_to_srgb(linear : f32) -> f32 {
  let c = clamp(linear, 0.0, 1.0);
  return select(c * 12.92, pow(c, 1.0 / 2.4) * 1.055 - 0.055, c > 0.0031308);
}

// Flat directional contribution. Every fragment receives the full
// `view.lightColor` modulated by `albedo`. Direction of the light is
// intentionally ignored -- 2D sprites lie in the XY plane facing the camera
// and are treated as omnidirectional receivers.
fn spriteLitDirectional(albedo : vec3<f32>) -> vec3<f32> {
  return albedo * view.lightColor;
}

// Flat point-light contribution. Applies the KHR-lights-punctual smooth-
// window range attenuation only. `attenuation` is 0 outside the light's
// range (`invRangeSquared`) and 1 at the light center; the reciprocal-square
// term gives the physical falloff. URP cap = 4 point lights per pass.
fn spriteLitPoint(p : PointLight, worldPos : vec3<f32>, albedo : vec3<f32>) -> vec3<f32> {
  let toLight = p.position - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let factor = 1.0 - (dSquared * p.invRangeSquared) * (dSquared * p.invRangeSquared);
  let attenuation = max(min(factor, 1.0), 0.0) / dSquared;
  return albedo * p.colorTimesIntensity * attenuation;
}

// Flat spot-light contribution. Same range attenuation as spriteLitPoint,
// modulated by a smoothstep cone factor (host-side degree -> cosine
// conversion). Spot direction only shapes the cone; it does not project
// onto a surface normal. URP cap = 4 spot lights per pass.
fn spriteLitSpot(s : SpotLight, worldPos : vec3<f32>, albedo : vec3<f32>) -> vec3<f32> {
  let toLight = s.position - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let factor = 1.0 - (dSquared * s.invRangeSquared) * (dSquared * s.invRangeSquared);
  let attenuation = max(min(factor, 1.0), 0.0) / dSquared;
  let cone = smoothstep(s.cosOuter, s.cosInner, dot(l, -s.direction));
  return albedo * s.colorTimesIntensity * attenuation * cone;
}

// Shared shading body used by both fs_main (LDR) and fs_main_hdr (HDR).
// The two entry points differ only in their tail-end clamp + srgb encode
// step (LDR clamp / HDR pass-through boundary).
fn spriteLitShadeAccum(albedo : vec3<f32>, worldPos : vec3<f32>) -> vec3<f32> {
  // Directional contribution (1 light, View UBO).
  var lit = spriteLitDirectional(albedo);
  // Point-light contribution (URP cap = 4; PointLightsArray.count).
  let pointCount = pointLightsBuffer.count;
  for (var i : u32 = 0u; i < pointCount; i = i + 1u) {
    let p = pointLightsBuffer.slots[i];
    lit = lit + spriteLitPoint(p, worldPos, albedo);
  }
  // Spot-light contribution (URP cap = 4).
  let spotCount = spotLightsBuffer.count;
  for (var i : u32 = 0u; i < spotCount; i = i + 1u) {
    let s = spotLightsBuffer.slots[i];
    lit = lit + spriteLitSpot(s, worldPos, albedo);
  }
  return lit;
}

fn applySceneFog(viewParams : View, color : vec3<f32>, alpha : f32, worldPos : vec3<f32>) -> vec4<f32> {
  var origin = viewParams.cameraPos;
  var direction = normalize(worldPos - origin);
  var rayDistance = length(worldPos - origin);
  if (viewParams.temporalProjection.z >= 0.5) {
    let nearH = viewParams.inverseViewProj * vec4<f32>(0.0, 0.0, 0.0, 1.0);
    let farH = viewParams.inverseViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
    let nearPoint = nearH.xyz / nearH.w;
    let farPoint = farH.xyz / farH.w;
    direction = normalize(farPoint - nearPoint);
    origin = worldPos - direction * dot(worldPos - viewParams.cameraPos, direction);
    rayDistance = max(dot(worldPos - origin, direction), 0.0);
  }
  return apply_fog(viewParams.fog, FogRay(origin, direction, rayDistance), vec4<f32>(color, alpha));
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv_atlas, material.baseColorTextureCoordinatesMetadata.zw);
  let albedo4 = texel * material.colorTint;
  let lit = spriteLitShadeAccum(albedo4.rgb, in.worldPos);
  // Strict clamp 0..1 before premultiplied alpha multiply keeps the LDR
  // path bounded even when a scene stacks many lights.
  let lit_rgba = clamp(vec4<f32>(lit, albedo4.a), vec4<f32>(0.0), vec4<f32>(1.0));
  let fogged = applySceneFog(view, lit_rgba.rgb, lit_rgba.a, in.worldPos);
  let premult = vec4<f32>(fogged.rgb * fogged.a, fogged.a);
  // LDR target is bgra8unorm; encode rgb via the sRGB transfer in-shader.
  return vec4<f32>(
    linear_to_srgb(premult.r),
    linear_to_srgb(premult.g),
    linear_to_srgb(premult.b),
    premult.a,
  );
}

@fragment
fn fs_main_hdr(in : VsOut) -> @location(0) vec4<f32> {
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv_atlas, material.baseColorTextureCoordinatesMetadata.zw);
  let albedo4 = texel * material.colorTint;
  let lit = spriteLitShadeAccum(albedo4.rgb, in.worldPos);
  // HDR variant: do NOT clamp the lit output to [0, 1]; let the tonemap
  // pass absorb HDR values > 1. Alpha stays clamped because the premult
  // math requires alpha in [0, 1].
  let alpha = clamp(albedo4.a, 0.0, 1.0);
  let fogged = applySceneFog(view, lit, alpha, in.worldPos);
  return vec4<f32>(fogged.rgb * fogged.a, fogged.a);
}

struct TemporalVsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uvAtlas : vec2<f32>,
  @location(1) @interpolate(linear) currentClip : vec4<f32>,
  @location(2) @interpolate(linear) previousClip : vec4<f32>,
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex_index : u32) -> TemporalVsOut {
  let vertex = resolveSpriteVertex(in, vertex_index);
  let currentWorld = meshes[0].worldFromLocal *
    instances[idx].localFromInstance * vec4<f32>(vertex.posLocal, 1.0);
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(vertex.posLocal, 1.0);
#endif
  var out : TemporalVsOut;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = out.currentClip;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  out.uvAtlas = vertex.uvAtlas;
  return out;
}

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uvAtlas, material.baseColorTextureCoordinatesMetadata.zw);
  let alpha = clamp(texel.a * material.colorTint.a, 0.0, 1.0);
  if (alpha <= 0.0) {
    discard;
  }
  return packSceneTemporal(in.currentClip, in.previousClip, 1.0);
}
// sprite-lit needs at least one light in the scene to be visible; for unlit
// sprites use forgeax::sprite (1 string change in MaterialAsset).
