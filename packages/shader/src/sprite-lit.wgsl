#pragma variant_axis STORAGE_BUFFER_AVAILABLE

#import forgeax_view::common::{View, Mesh, InstanceData, PointLight, SpotLight, view, meshes, instances, pointLightsBuffer, spotLightsBuffer}

// @forgeax/engine-shader - sprite-lit.wgsl
// (feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w4).
//
// Parallel 4th sprite shading model (alongside forgeax::sprite / unlit /
// pbr-standard). Lights a 2D sprite quad with the 3 punctual light kinds
// (DirectionalLight + PointLight + SpotLight) using a Half-Lambert squared
// diffuse formula and a fragment-side hardcoded normal of (0, 0, 1).
//
// SSOTs:
//   - requirements section 2 (12 in-scope items)
//   - requirements section 4 AC-01 .. AC-15
//   - research F-3 (Half-Lambert math table, 4-angle SSOT)
//   - research F-5 (sprite VsOut byte-identical contract)
//   - plan-strategy D-2 (per-fragment worldPos via uv_atlas inversion, see
//     spriteLitWorldPos block-comment; the original D-2 inverseViewProj
//     unproject path turned out to be infeasible under constraint #2 +
//     AC-03 jointly because NDC.xy from @builtin(position).xy requires a
//     viewport_size uniform no shader binding provides today)
//   - plan-strategy D-3 (Half-Lambert squared single-formula lock)
//   - plan-strategy D-5 (STORAGE_BUFFER_AVAILABLE variant axis day-1)
//   - plan-strategy D-6 (4 BGL byte-identical to sprite path)
//
// What this shader is NOT (OOS-1 .. OOS-7):
//   - no normal-map sampling          (OOS-1 follow-up sprite-lit-normal-map)
//   - no shadow receiver / caster     (OOS-2 / OOS-3 follow-ups)
//   - no alternative shading formulas (OOS-4)
//   - no Godot-style light_mode blends (OOS-5)
//   - no IBL ambient                  (OOS-6)
//   - no HDRP cluster-forward path    (OOS-7)
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
//   @group(1) @binding(3) metallicRoughnessSampler   sampler          (UNUSED)
//   @group(1) @binding(4) metallicRoughnessTexture   texture_2d<f32>  (UNUSED)
//   @group(1) @binding(5) normalSampler              sampler          (UNUSED)
//   @group(1) @binding(6) normalTexture              texture_2d<f32>  (UNUSED)
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
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
// Unused but declared so the BindGroupLayout binding-set matches the
// shared PBR layout byte-for-byte (4 placeholder slots bound to
// pipelineState.defaultSampler / defaultWhiteTextureView at the host side;
// sprite.wgsl L118-129 same shape). sprite-lit MUST NOT sample these in
// fs_main / fs_main_hdr -- OOS-1 normal-map sampling is a follow-up feat.
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

// AC-03 byte-identical to sprite.wgsl VsOut: clip + uv_atlas only. Normal
// is hardcoded fragment-side (AC-04); worldPos is reconstructed per-fragment
// from uv_atlas + material.region/pivotAndSize + meshes[0].worldFromLocal
// (see spriteLitWorldPos block-comment for why the originally-planned
// fragment-side inverseViewProj unproject path was infeasible).
struct VsOut {
  @builtin(position) clip     : vec4<f32>,
  @location(0)       uv_atlas : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex_index : u32) -> VsOut {
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
  // AC-11 instances path day-1: the world transform is meshes[0].worldFromLocal
  // * instances[idx].localFromInstance * vec4(pos_local, 1.0) -- same chain
  // sprite.wgsl + default-standard-pbr.wgsl use.
  let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(pos_local, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv_atlas = uv_atlas;
  return out;
}

// AC-05 Half-Lambert squared SSOT (research F-3 4-angle table). No
// max(NdotL, 0) clamp -- the formula self-clamps at NdotL = -1 -> 0.0 and
// gives the back-light shading Valve's HL2 art direction wanted. Squaring
// pushes the terminator (NdotL = 0) down to 0.25 and concentrates the
// brights near NdotL = 1.
fn halfLambertSquared(nDotL : f32) -> f32 {
  let h = nDotL * 0.5 + 0.5;
  return h * h;
}

// linear_to_srgb mirrors sprite.wgsl L251-254: per-channel IEC 61966-2-1
// transfer used by the LDR fragment entry to encode the bgra8unorm swap
// chain output (the format is not hardware-sRGB-encoded; the shader does it).
fn linear_to_srgb(linear : f32) -> f32 {
  let c = clamp(linear, 0.0, 1.0);
  return select(c * 12.92, pow(c, 1.0 / 2.4) * 1.055 - 0.055, c > 0.0031308);
}

// AC-04 hardcoded normal: sprites lie in the XY plane facing +Z. The
// engine does NOT consume in.normal (vertex normal attribute is read by
// the VsIn layout for byte-identical mesh chain reuse, but the lighting
// math treats every fragment as if its surface normal were (0, 0, 1)).
fn spriteLitNormal() -> vec3<f32> {
  return vec3<f32>(0.0, 0.0, 1.0);
}

// Reconstruct per-fragment world-space position WITHOUT viewport size and
// WITHOUT adding a VsOut interpolant (AC-03 byte-identical VsOut + constraint
// #2 no View UBO extension are jointly hard limits).
//
// Strategy: invert the non-slice vs_main UV -> pos_local mapping using the
// uv_atlas interpolant already in VsOut, then re-apply meshes[0].worldFromLocal
// per fragment. This trades the brittle screen-space inverseViewProj unproject
// path (which would need a viewport_size uniform that constraint #2 forbids)
// for a per-fragment per-entity worldPos that is correct for every typical
// sprite-lit case (1 entity per draw + non-slice quad UVs from the engine's
// built-in HANDLE_QUAD).
//
// vs_main non-slice path (sprite-lit.wgsl L134-138 byte-identical to
// sprite.wgsl):
//   uv_eff   = vec2(in.uv.x, 1.0 - in.uv.y)
//   pos_local = vec3((uv_eff - pivot) * size, 0.0)
//   uv_atlas = uv_eff * region.zw + region.xy
//
// Inversion in fragment:
//   uv_eff   = (in.uv_atlas - region.xy) / region.zw
//   pos_local = vec3((uv_eff - pivot) * size, 0.0)
//   world    = meshes[0].worldFromLocal * vec4(pos_local, 1.0)
//
// Per-fragment vs first-instance behaviour:
//   - first-instance was constant across all fragments of the quad
//     (broken: every PointLight/SpotLight saw the same worldPos so toLight
//     was the same vector for every pixel of every quad).
//   - this version gives every fragment its own worldPos via the per-pixel
//     uv_atlas interpolant -> point/spot light NdotL + attenuation respond
//     to actual fragment positions across the quad surface (AC-06 evidence).
//
// Multi-instance limitation:
//   instances[idx].localFromInstance is vertex-only (instance_index is a
//   @builtin only in vs_main). AC-03 forbids extending VsOut to carry idx as
//   a @interpolate(flat) u32 interpolant, and constraint #2 forbids extending
//   View UBO to carry a viewport_size uniform that would let us do a true
//   screen-space inverseViewProj unproject. For ECS scenes with N instanced
//   quads under one MeshFilter entity, this implementation collapses the
//   per-instance offset to identity. Plan-strategy D-2 was authored under the
//   assumption that the screen-space unproject path was feasible without
//   extending the View UBO; this turned out to be incorrect (NDC.xy
//   reconstruction from @builtin(position).xy fundamentally needs viewport
//   pixel dimensions which no @group(0)/@group(1)/@group(2)/@group(3) binding
//   provides). The per-entity worldPos here is the strictly best path under
//   the joint AC-03 + #2 constraint box.
//
// 9-slice path limitation:
//   The 9-slice vs_main branch computes pos_local from a discrete u_pos/v_pos
//   slice table, not from uv_eff -- so the inverse-via-uv_atlas path here
//   does not reconstruct pos_local accurately under sliceMode != 0. sprite-lit
//   targets standard 2D quad rendering; 9-slice UI panels are an OOS extension
//   per D-3 and would require a separate worldPos derivation.
fn spriteLitWorldPos(uv_atlas : vec2<f32>) -> vec3<f32> {
  let uv_eff = (uv_atlas - material.region.xy) / material.region.zw;
  let pivot  = material.pivotAndSize.xy;
  let size   = material.pivotAndSize.zw;
  let pos_local = vec3<f32>((uv_eff - pivot) * size, 0.0);
  let world4 = meshes[0].worldFromLocal * vec4<f32>(pos_local, 1.0);
  return world4.xyz;
}

// Half-Lambert direct directional contribution. Mirrors evalDirectionalNoShadow
// in lighting-directional.wgsl in spirit (no shadow tap), but uses the
// non-PBR Half-Lambert squared diffuse instead of GGX -- sprite-lit is
// non-physical by design (D-3 + research F-3).
fn spriteLitDirectional(normal : vec3<f32>, albedo : vec3<f32>) -> vec3<f32> {
  let l = normalize(-view.lightDir);
  let nDotL = dot(normal, l);
  return albedo * view.lightColor * halfLambertSquared(nDotL);
}

// Half-Lambert point-light contribution. Mirrors evalPoint in
// lighting-punctual.wgsl in shape (inverse-square attenuation with the same
// range factor) but swaps the Cook-Torrance GGX brdf for Half-Lambert
// squared. URP cap = 4 (research F-2; PointLightsArray.slots is array<,4>).
fn spriteLitPoint(p : PointLight, worldPos : vec3<f32>, normal : vec3<f32>, albedo : vec3<f32>) -> vec3<f32> {
  let toLight = p.position - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let nDotL = dot(normal, l);
  let factor = 1.0 - (dSquared * p.invRangeSquared) * (dSquared * p.invRangeSquared);
  let attenuation = max(min(factor, 1.0), 0.0) / dSquared;
  return albedo * p.colorTimesIntensity * halfLambertSquared(nDotL) * attenuation;
}

// Half-Lambert spot-light contribution. Mirrors evalSpot in
// lighting-punctual.wgsl in shape; smoothstep cone factor with same
// cosInner / cosOuter semantics (host-side degree -> cosine conversion).
fn spriteLitSpot(s : SpotLight, worldPos : vec3<f32>, normal : vec3<f32>, albedo : vec3<f32>) -> vec3<f32> {
  let toLight = s.position - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let nDotL = dot(normal, l);
  let factor = 1.0 - (dSquared * s.invRangeSquared) * (dSquared * s.invRangeSquared);
  let attenuation = max(min(factor, 1.0), 0.0) / dSquared;
  let cone = smoothstep(s.cosOuter, s.cosInner, dot(l, -s.direction));
  return albedo * s.colorTimesIntensity * halfLambertSquared(nDotL) * attenuation * cone;
}

// Shared shading body used by both fs_main (LDR) and fs_main_hdr (HDR).
// The two entry points differ only in their tail-end clamp + srgb encode
// step (AC-09 / R6 mitigation boundary).
fn spriteLitShadeAccum(albedo : vec3<f32>, normal : vec3<f32>, worldPos : vec3<f32>) -> vec3<f32> {
  // Directional contribution (1 light, View UBO).
  var lit = spriteLitDirectional(normal, albedo);
  // Point-light contribution (URP cap = 4; PointLightsArray.count).
  let pointCount = pointLightsBuffer.count;
  for (var i : u32 = 0u; i < pointCount; i = i + 1u) {
    let p = pointLightsBuffer.slots[i];
    lit = lit + spriteLitPoint(p, worldPos, normal, albedo);
  }
  // Spot-light contribution (URP cap = 4).
  let spotCount = spotLightsBuffer.count;
  for (var i : u32 = 0u; i < spotCount; i = i + 1u) {
    let s = spotLightsBuffer.slots[i];
    lit = lit + spriteLitSpot(s, worldPos, normal, albedo);
  }
  return lit;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv_atlas);
  let albedo4 = texel * material.colorTint;
  let normal = spriteLitNormal();
  // worldPos: per-fragment per-entity reconstruction via uv_atlas inversion
  // (see spriteLitWorldPos doc). Replaces the first-instance constant-across-
  // quad approximation; correct for the typical 1-entity-per-draw sprite-lit
  // case which is the AC-06 visualEvidence target.
  let worldPos = spriteLitWorldPos(in.uv_atlas);
  let lit = spriteLitShadeAccum(albedo4.rgb, normal, worldPos);
  // R6 mitigation: strict clamp 0..1 before premultiplied alpha multiply.
  let lit_rgba = clamp(vec4<f32>(lit, albedo4.a), vec4<f32>(0.0), vec4<f32>(1.0));
  let premult = vec4<f32>(lit_rgba.rgb * lit_rgba.a, lit_rgba.a);
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
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv_atlas);
  let albedo4 = texel * material.colorTint;
  let normal = spriteLitNormal();
  let worldPos = spriteLitWorldPos(in.uv_atlas);
  let lit = spriteLitShadeAccum(albedo4.rgb, normal, worldPos);
  // AC-09 HDR variant: do NOT clamp the lit output to [0, 1]; let the
  // tonemap pass absorb HDR values > 1. R6 mitigation still applies to
  // alpha which we keep clamped (premult math requires alpha in [0, 1]).
  let alpha = clamp(albedo4.a, 0.0, 1.0);
  return vec4<f32>(lit * alpha, alpha);
}
// sprite-lit needs at least one light in the scene to be visible; for unlit
// sprites use forgeax::sprite (1 string change in MaterialAsset). OOS-1
// normal-map sampling is a follow-up feat-future-sprite-lit-normal-map.
