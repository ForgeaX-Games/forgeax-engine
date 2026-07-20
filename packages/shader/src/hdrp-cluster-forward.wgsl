// hdrp-cluster-forward.wgsl — HDRP cluster-forward punctual light evaluation.
// feat-20260608-cluster-lighting M4 / w17.
//
// This shader evaluates punctual lights (point + spot) using the cluster-forward
// data structure: per-cluster light index lists pre-binned by the CPU binner.
//
// BGL layout (slot 3..6, physically isolated from URP slots 0..2, plan D-1):
//   @group(2) @binding(3) var<storage> light_data: array<LightSlot, 256>;
//   @group(2) @binding(4) var<storage> cluster_grid: array<u32>;
//   @group(2) @binding(5) var<storage> light_index_list: array<u32>;
//   @group(2) @binding(6) var<uniform> cluster_uniform: ClusterUniform;
//
// LightSlot 64B std430 layout (byte-frozen, AC-11 double-sided lock):
//   [ 0..2 ] position         vec3<f32>
//   [   3 ] invRangeSquared  f32
//   [ 4..6 ] color            vec3<f32>  (host pre-multiplied: color * intensity)
//   [   7 ] cosInner         f32         (point: 1.0)
//   [ 8..10] direction        vec3<f32>  (point: vec3(0))
//   [  11 ] cosOuter         f32         (point: 0.0)
//   [  12 ] kind             u32         (POINT = 0, SPOT = 1)
//   [  13 ] shadowAtlasLayer i32         (point + shadow: 0..3; else -1)
//   [  14 ] near             f32 bits    (point + shadow: PointLightShadow.nearPlane)
//   [  15 ] far              f32 bits    (point + shadow: PointLightShadow.farPlane)
//
// feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
// the prior `pad u32x3 = 0` lanes at byte 52..64 carry the per-light shadow
// triple (shadowAtlasLayer i32, near f32, far f32). Spot lights and
// shadow-less point lights leave the lanes at the (sentinel -1, 0, 0) default
// so the shader's `kind_and_pad.y >= 0` gate skips cube-array sampling.
//
// static_assert(sizeof(LightSlot) == 64) — AC-11 WGSL side lock.
//
// Cluster uniform fields (std140, 32 bytes):
//   gridX, gridY, gridZ (u32) + pad (u32), near, far, logFarOverNear (f32) + pad (u32)
//
// Import flow: main PBR shader #imports this module for cluster evaluation.
// This file does NOT declare @fragment — the caller's fragment entry does.

#define_import_path forgeax_hdrp::cluster_forward

// feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-3 (plan-strategy §D-8):
// when POINT_SHADOW_AVAILABLE is set the cluster-forward path samples the
// shared cube_array shadow atlas via `sample_shadow_cube_hw2x2` from
// `forgeax_pbr::shadow_pcf`. The atlas + comparison sampler bindings live at
// `@group(0) @binding(5)` / `@binding(4)` (shared with URP via common.wgsl);
// the per-light `(layer, near, far)` triple rides the std430 LightSlot pad
// lanes (`kind_and_pad.yzw`) byte 52..64, packed by `packLightSlot` (see
// `light-buffer-layout.ts`). Round-2: the runtime view BGL is extended to
// declare binding 5 + the vite-plugin-shader define is registered, so the
// gated block compiles into the production HDRP variant.
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::shadow_pcf::{sample_shadow_cube_hw2x2}
// Pull in the @group(0) @binding(5) shadowAtlas + binding(4) shadowSampler
// declarations from common.wgsl so the free-identifier references in
// `evaluate_point_light` resolve through naga_oil's import scope.
#import forgeax_view::common::{shadowAtlas, shadowSampler}
#endif

#ifdef CLUSTER_FORWARD_AVAILABLE

// ── enums ─────────────────────────────────────────────────────────────────────

const KIND_POINT: u32 = 0u;
const KIND_SPOT: u32 = 1u;

// ── LightSlot (64 B std430, byte-frozen) ─────────────────────────────────────

struct LightSlot {
  position        : vec4<f32>,  // [ 0..2] position, [3] invRangeSquared
  color           : vec4<f32>,  // [ 4..6] color,      [7] cosInner
  direction       : vec4<f32>,  // [ 8..10] direction, [11] cosOuter
  kind_and_pad    : vec4<u32>,  // [12] kind,          [13..15] pad = 0
};

// AC-11 WGSL-side absolute-value lock: sizeof(LightSlot) must be 64.
// Source of truth: LIGHTSLOT_LAYOUT.byteSize in light-buffer-layout.ts.
const LIGHTSLOT_BYTE_SIZE: u32 = 64u;
// AC-11 WGSL-side lock: sizeof(LightSlot) == 64.
// SSOT: LIGHTSLOT_LAYOUT.byteSize in light-buffer-layout.ts.
// WGSL static_assert not supported by current naga_oil compose path.

// ── ClusterUniform (std140, 32 bytes) ────────────────────────────────────────

struct ClusterUniform {
  grid           : vec4<u32>,  // x = gridX, y = gridY, z = gridZ, w = pad
  // near_far_log.w carries the SSAO intensity scalar
  // (feat-20260612-hdrp-ssao scope-amend-webgl2-ubo): folding intensity
  // into this previously-unused std140 pad lane keeps fragment-stage UBO
  // count under the WebGL2 budget (max_uniform_buffers_per_shader_stage=11).
  // Read by default-standard-pbr.wgsl §SSAO synthesis as
  // `cluster_uniform.near_far_log.w`.
  near_far_log   : vec4<f32>,  // x = near, y = far, z = logFarOverNear, w = ssaoIntensity
};

// ── binding declarations ─────────────────────────────────────────────────────

#ifdef CLUSTER_FORWARD_AVAILABLE
@group(2) @binding(3) var<storage, read> light_data      : array<LightSlot, 256>;
@group(2) @binding(4) var<storage, read> cluster_grid     : array<u32>;
@group(2) @binding(5) var<storage, read> light_index_list : array<u32>;
@group(2) @binding(6) var<uniform>        cluster_uniform : ClusterUniform;
#endif

// ── helper: get_ssao_intensity (scope-amend-webgl2-ubo) ──────────────────────
//
// SSAO intensity scalar lives in cluster_uniform.near_far_log.w (formerly
// std140 pad). Exposed via this getter so default-standard-pbr.wgsl can read
// it without naming the cluster UBO directly across the naga_oil import
// boundary (`cluster_uniform` is declared inside this module under
// CLUSTER_FORWARD_AVAILABLE; cross-module references go through exported
// functions).

#ifdef CLUSTER_FORWARD_AVAILABLE
fn get_ssao_intensity() -> f32 {
  return cluster_uniform.near_far_log.w;
}
#endif

// ── helper: view_z_to_z_slice ─────────────────────────────────────────────────
//
// idTech6 inverse log-z formula (research Finding 1, Bevy cluster.wgsl).
// Maps view-space z (negative, camera-forward) to cluster Z slice index.

fn view_z_to_z_slice(view_z: f32, grid_z: u32, near: f32, far: f32, log_far_over_near: f32) -> u32 {
  if (view_z >= -near) {
    return 0u;
  }
  let slice = floor(log(-view_z / near) / log_far_over_near * f32(grid_z));
  let u_slice = u32(slice);
  if (u_slice >= grid_z) {
    return grid_z - 1u;
  }
  return u_slice;
}

// ── helper: ndc_position_to_cluster ───────────────────────────────────────────
//
// Maps NDC coordinates to cluster cell index (XY + Z).

fn ndc_position_to_cluster(
  ndc     : vec3<f32>,
  view_z  : f32,
  grid_x  : u32,
  grid_y  : u32,
  grid_z  : u32,
  near    : f32,
  far     : f32,
  log_far : f32,
) -> vec3<u32> {
  let cx = clamp(u32(floor((ndc.x * 0.5 + 0.5) * f32(grid_x))), 0u, grid_x - 1u);
  let cy = clamp(u32(floor((ndc.y * 0.5 + 0.5) * f32(grid_y))), 0u, grid_y - 1u);
  let cz = view_z_to_z_slice(view_z, grid_z, near, far, log_far);
  return vec3(cx, cy, cz);
}

// ── helper: evaluate_point_light ──────────────────────────────────────────────
//
// Computes radiance contribution of one point light at a given surface point.
// Uses the inverse-square falloff (invRangeSquared = 1/range^2).
// When invRangeSquared == 0, the light has infinite range (no distance attenuation).

fn evaluate_point_light(
  light         : LightSlot,
  world_pos     : vec3<f32>,
  N             : vec3<f32>,
  V             : vec3<f32>,
  base_color    : vec3<f32>,
  metallic      : f32,
  roughness     : f32,
) -> vec3<f32> {
  let L_vec = light.position.xyz - world_pos;
  let dist_sq = dot(L_vec, L_vec);
  let L = normalize(L_vec);
  let H = normalize(V + L);

  // KHR_lights_punctual quartic range attenuation (lighting-punctual.wgsl:63-64).
  //   atten = max(min(1 - (d^2 * invR^2)^2, 1), 0) / max(d^2, 1e-4)
  // When invRangeSquared=0 (infinite range), factor=1, atten=1/d^2.
  let factor = 1.0 - (dist_sq * light.position.w) * (dist_sq * light.position.w);
  let atten = max(min(factor, 1.0), 0.0) / max(dist_sq, 1e-4);

  // GGX BRDF evaluation (simplified single-sample; full PBR integration
  // in the calling fragment shader reuses brdf.wgsl helpers).
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  // Fresnel (Schlick)
  let F0 = mix(vec3(0.04), base_color, metallic);
  let F = F0 + (vec3(1.0) - F0) * pow(1.0 - VdotH, 5.0);

  // GGX distribution
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
  let D = alpha2 / (3.14159265 * denom * denom);

  // Smith geometry
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let G1V = NdotV / (NdotV * (1.0 - k) + k);
  let G1L = NdotL / (NdotL * (1.0 - k) + k);
  let G = G1V * G1L;

  let specular = (F * D * G) / max(4.0 * NdotV * NdotL, 0.001);
  let kD = (vec3(1.0) - F) * (1.0 - metallic);
  let diffuse = kD * base_color / 3.14159265;

  let lit = (diffuse + specular) * NdotL * light.color.xyz * atten;

  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-3 (plan-strategy §D-8):
  // gated shadow attenuation. `kind_and_pad.y` carries `shadowAtlasLayer` as
  // i32 (sentinel -1 = no shadow); `kind_and_pad.zw` carry `near` / `far`
  // bitcast<f32>(...) for the depth-ref reconstruction (matches the
  // `packLightSlot` §D-8 pad-lane payload). The block is `#ifdef`-gated on
  // `POINT_SHADOW_AVAILABLE` so the cluster-forward path stays unchanged
  // until the runtime view BGL declares the cube_array atlas at
  // `@group(0) @binding(5)`. Sentinel layer (< 0) returns lit verbatim.
#ifdef POINT_SHADOW_AVAILABLE
  let shadowLayerI = bitcast<i32>(light.kind_and_pad.y);
  if (shadowLayerI >= 0) {
    let near = bitcast<f32>(light.kind_and_pad.z);
    let far = bitcast<f32>(light.kind_and_pad.w);
    let toLight = light.position.xyz - world_pos;
    let lightLocal = vec3<f32>(toLight.x, toLight.y, -toLight.z);
    let absV = abs(toLight);
    let largestAxis = max(absV.x, max(absV.y, absV.z));
    let denom = max(largestAxis * (far - near), 1e-6);
    let depthRef = clamp(far * (largestAxis - near) / denom, 0.0, 1.0);
    let nDotL = max(dot(N, normalize(toLight)), 0.0);
    // Match URP `evalPointShadowed` defaults: depthBias=0.005, normalBias=0.05.
    // Future tweak: thread per-light bias from PointLightShadow ECS component
    // through LightSlot or an auxiliary buffer.
    let shadowFactor = sample_shadow_cube_hw2x2(
      shadowAtlas, shadowSampler, lightLocal, shadowLayerI,
      depthRef, 0.005, 0.05, nDotL,
    );
    return lit * shadowFactor;
  }
#endif
  return lit;
}

// ── helper: evaluate_spot_light ───────────────────────────────────────────────
//
// Computes radiance contribution of one spot light. Identical point-light
// falloff with the addition of a cone-angle smoothstep (inner -> outer cone).

fn evaluate_spot_light(
  light         : LightSlot,
  world_pos     : vec3<f32>,
  N             : vec3<f32>,
  V             : vec3<f32>,
  base_color    : vec3<f32>,
  metallic      : f32,
  roughness     : f32,
) -> vec3<f32> {
  let L_vec = light.position.xyz - world_pos;
  let dist_sq = dot(L_vec, L_vec);
  let L = normalize(L_vec);
  let H = normalize(V + L);

  // KHR_lights_punctual quartic range attenuation (lighting-punctual.wgsl:63-64).
  let atten_dist_factor = 1.0 - (dist_sq * light.position.w) * (dist_sq * light.position.w);
  let atten_dist = max(min(atten_dist_factor, 1.0), 0.0) / max(dist_sq, 1e-4);

  // Cone attenuation: smoothstep between cosOuter and cosInner
  let spot_dir = normalize(light.direction.xyz);
  let cos_angle = dot(-L, spot_dir);
  let spot_atten = smoothstep(light.direction.w, light.color.w, cos_angle);

  let atten = atten_dist * spot_atten;

  // GGX BRDF (same as point light)
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  let F0 = mix(vec3(0.04), base_color, metallic);
  let F = F0 + (vec3(1.0) - F0) * pow(1.0 - VdotH, 5.0);

  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
  let D = alpha2 / (3.14159265 * denom * denom);

  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let G1V = NdotV / (NdotV * (1.0 - k) + k);
  let G1L = NdotL / (NdotL * (1.0 - k) + k);
  let G = G1V * G1L;

  let specular = (F * D * G) / max(4.0 * NdotV * NdotL, 0.001);
  let kD = (vec3(1.0) - F) * (1.0 - metallic);
  let diffuse = kD * base_color / 3.14159265;

  return (diffuse + specular) * NdotL * light.color.xyz * atten;
}

// ── main entry: evaluate cluster lights at a fragment ────────────────────────

/**
 * Evaluate all punctual lights that overlap the cluster containing `ndc`
 * (normalized device coordinates) and `view_z` (view-space depth).
 *
 * Call from fragment shader with pre-computed NDC (from @builtin(position)
 * and viewport), view-space z, and surface parameters. Returns the
 * accumulated radiance from all point + spot lights in the cluster.
 */
fn evaluate_cluster_lights(
  ndc          : vec3<f32>,
  view_z       : f32,
  world_pos    : vec3<f32>,
  N            : vec3<f32>,
  V            : vec3<f32>,
  base_color   : vec3<f32>,
  metallic     : f32,
  roughness    : f32,
) -> vec3<f32> {
  let gx = cluster_uniform.grid.x;
  let gy = cluster_uniform.grid.y;
  let gz = cluster_uniform.grid.z;
  let near = cluster_uniform.near_far_log.x;
  let far = cluster_uniform.near_far_log.y;
  let log_far = cluster_uniform.near_far_log.z;

  let cluster_idx = ndc_position_to_cluster(ndc, view_z, gx, gy, gz, near, far, log_far);
  let cluster_linear = cluster_idx.z * gy * gx + cluster_idx.y * gx + cluster_idx.x;

  // cluster_grid stores [offset, count] pairs per cluster
  let grid_offset = cluster_linear * 2u;
  let list_offset = cluster_grid[grid_offset];
  let list_count  = cluster_grid[grid_offset + 1u];

  var total_radiance = vec3(0.0);

  for (var i = 0u; i < list_count; i = i + 1u) {
    let light_idx = light_index_list[list_offset + i];
    let light = light_data[light_idx];
    let kind = light.kind_and_pad.x;

    if (kind == KIND_POINT) {
      total_radiance += evaluate_point_light(light, world_pos, N, V, base_color, metallic, roughness);
    } else {
      total_radiance += evaluate_spot_light(light, world_pos, N, V, base_color, metallic, roughness);
    }
  }

  return total_radiance;
}

#endif // CLUSTER_FORWARD_AVAILABLE
