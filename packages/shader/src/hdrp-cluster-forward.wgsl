// hdrp-cluster-forward.wgsl — HDRP cluster-forward punctual light evaluation.
// feat-20260608-cluster-lighting M4 / w17.
//
// The cluster module owns membership and raw payload decoding only. Punctual
// BRDF, range, cone, PCF, and fail-open behavior live in lighting-punctual.

#define_import_path forgeax_hdrp::cluster_forward

#import forgeax_pbr::lighting_punctual::{evalPoint, evalSpot, evalSpotShadowed}
#import forgeax_view::common::{view}
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::lighting_punctual::{evalPointShadowed}
#endif

#ifdef CLUSTER_FORWARD_AVAILABLE

const KIND_POINT: u32 = 0u;
const KIND_SPOT: u32 = 1u;

// LightSlot is the byte-frozen 64B std430/std140 transport contract.
// [0..2] position, [3] invRangeSquared
// [4..6] colorTimesIntensity, [7] cosInner
// [8..10] direction, [11] cosOuter
// [12] raw kind u32, [13] shadow identity i32
// [14..15] point near/far f32 bits; spot keeps these lanes zero.
struct LightSlot {
  position        : vec4<f32>,
  color           : vec4<f32>,
  direction       : vec4<f32>,
  kind_and_shadow : vec4<u32>,
};

const LIGHTSLOT_BYTE_SIZE: u32 = 64u;

struct ClusterUniform {
  grid         : vec4<u32>,
  near_far_log : vec4<f32>,
};

#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(3) var<storage, read> light_data      : array<LightSlot, 256>;
@group(2) @binding(4) var<storage, read> cluster_grid     : array<u32>;
@group(2) @binding(5) var<storage, read> light_index_list : array<u32>;
#else
@group(2) @binding(3) var<uniform> light_data_uniform : array<LightSlot, 128>;
#endif
@group(2) @binding(6) var<uniform> cluster_uniform : ClusterUniform;

fn get_ssao_intensity() -> f32 {
  return cluster_uniform.near_far_log.w;
}

fn view_z_to_z_slice(
  view_z : f32,
  grid_z : u32,
  near   : f32,
  far    : f32,
  log_far_over_near : f32,
) -> u32 {
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

// Decode one kind first, then delegate the complete evaluation to the shared
// punctual owner. Unknown kinds are explicitly zero contribution.
fn evaluate_cluster_light(
  light      : LightSlot,
  world_pos  : vec3<f32>,
  normal     : vec3<f32>,
  view_dir   : vec3<f32>,
  base_color : vec3<f32>,
  metallic   : f32,
  alpha_sq   : f32,
  f0         : vec3<f32>,
) -> vec3<f32> {
  let kind = light.kind_and_shadow.x;
  if (kind == KIND_POINT) {
#ifdef POINT_SHADOW_AVAILABLE
    let layer = bitcast<i32>(light.kind_and_shadow.y);
    if (layer >= 0) {
      return evalPointShadowed(
        light.position.xyz, light.color.xyz, light.position.w,
        world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
        layer,
        bitcast<f32>(light.kind_and_shadow.z),
        bitcast<f32>(light.kind_and_shadow.w),
        0.005, 0.05,
      );
    }
#endif
    return evalPoint(
      light.position.xyz, light.color.xyz, light.position.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
    );
  }
  if (kind == KIND_SPOT) {
    let tile = bitcast<i32>(light.kind_and_shadow.y);
    if (tile >= 0) {
      return evalSpotShadowed(
        light.position.xyz, light.direction.xyz, light.color.xyz,
        // LightSlot packs cosInner in color.w and cosOuter in direction.w;
        // keep the evaluator's named cone order intact at the decode boundary.
        light.color.w, light.direction.w, light.position.w,
        world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
        view.spotLightViewProj[tile], tile, 0.005, 0.05,
      );
    }
    return evalSpot(
      light.position.xyz, light.direction.xyz, light.color.xyz,
      light.color.w, light.direction.w, light.position.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
    );
  }
  return vec3<f32>(0.0);
}

fn evaluate_cluster_lights(
  ndc        : vec3<f32>,
  view_z     : f32,
  world_pos  : vec3<f32>,
  normal     : vec3<f32>,
  view_dir   : vec3<f32>,
  base_color : vec3<f32>,
  metallic   : f32,
  alpha_sq   : f32,
  f0         : vec3<f32>,
) -> vec3<f32> {
  let gx = cluster_uniform.grid.x;
  let gy = cluster_uniform.grid.y;
  let gz = cluster_uniform.grid.z;
  let near = cluster_uniform.near_far_log.x;
  let far = cluster_uniform.near_far_log.y;
  let log_far = cluster_uniform.near_far_log.z;
  var total_radiance = vec3<f32>(0.0);

#if STORAGE_BUFFER_AVAILABLE == true
  let cluster_idx = ndc_position_to_cluster(ndc, view_z, gx, gy, gz, near, far, log_far);
  let cluster_linear = cluster_idx.z * gy * gx + cluster_idx.y * gx + cluster_idx.x;
  let grid_offset = cluster_linear * 2u;
  let list_offset = cluster_grid[grid_offset];
  let list_count = cluster_grid[grid_offset + 1u];
  for (var i = 0u; i < list_count; i = i + 1u) {
    let light = light_data[light_index_list[list_offset + i]];
    total_radiance += evaluate_cluster_light(
      light, world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
    );
  }
#else
  let light_count = min(cluster_uniform.grid.w, 128u);
  for (var i = 0u; i < 128u; i = i + 1u) {
    if (i >= light_count) {
      break;
    }
    total_radiance += evaluate_cluster_light(
      light_data_uniform[i], world_pos, normal, view_dir,
      base_color, metallic, alpha_sq, f0,
    );
  }
#endif
  return total_radiance;
}

#endif // CLUSTER_FORWARD_AVAILABLE
