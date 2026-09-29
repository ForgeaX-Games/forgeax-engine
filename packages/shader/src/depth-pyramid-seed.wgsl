#define_import_path forgeax_depth_pyramid::seed

// The shared closest-depth pyramid uses one r32float view for each graph mip.
const DEPTH_PYRAMID_FORMAT : u32 = 1u;
const DEPTH_PYRAMID_EMPTY_DEPTH : f32 = 3.402823e+38;

@group(0) @binding(0) var sourceDepth : texture_depth_2d;
@group(0) @binding(1) var pyramidOutput : texture_storage_2d<r32float, write>;
#import forgeax_view::common::View
@group(0) @binding(2) var<uniform> view : View;

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

// WebGPU depth attachments expose perspective depth, not a linear distance.
// The pyramid stores the positive view distance consumed by screen-space
// tracers such as SSR. The shared View UBO carries the active projection
// range, so this conversion does not create a second camera or projection
// owner.
fn linearizeViewDepth(value : f32) -> f32 {
  if (!isFinite(value) || value <= 0.0 || value > 1.0) {
    return DEPTH_PYRAMID_EMPTY_DEPTH;
  }
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  if (!isFinite(near) || !isFinite(far) || near <= 0.0 || far <= near) {
    return DEPTH_PYRAMID_EMPTY_DEPTH;
  }
  let orthographic = view.temporalProjection.z > 0.5;
  let distance = select(
    near / (value + (1.0 - value) * (near / far)),
    far - value * (far - near),
    orthographic,
  );
  return select(DEPTH_PYRAMID_EMPTY_DEPTH, distance, isFinite(distance) && distance > 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourceDepth, 0);
  let outputSize = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= outputSize)) {
    return;
  }
  // Match the reduction coverage contract: floor the start and ceil the end
  // so an odd source boundary is conservatively present in both neighbors.
  let first = globalId.xy * sourceSize / outputSize;
  let end = min(
    ((globalId.xy + vec2<u32>(1u)) * sourceSize + outputSize - vec2<u32>(1u)) /
      outputSize,
    sourceSize,
  );
  var nearestDepth = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let sample = textureLoad(sourceDepth, vec2<i32>(vec2<u32>(x, y)), 0);
      if (isFinite(sample) && sample > 0.0 && sample <= 1.0) {
        nearestDepth = max(nearestDepth, sample);
      }
    }
  }
  // Both supported depth projections are monotonic, so linearize once after
  // selecting the nearest valid source sample.
  let depth = linearizeViewDepth(nearestDepth);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}

// Occlusion culling needs a conservative farthest bound: an occluder texel
// hides a candidate only when every covered source sample is nearer. Any
// empty or invalid sample (sky, cleared depth) therefore leaves the texel
// EMPTY so nothing behind that hole is culled.
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed_furthest(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourceDepth, 0);
  let outputSize = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= outputSize)) {
    return;
  }
  let first = globalId.xy * sourceSize / outputSize;
  let end = min(
    ((globalId.xy + vec2<u32>(1u)) * sourceSize + outputSize - vec2<u32>(1u)) /
      outputSize,
    sourceSize,
  );
  var farthestDepth = 1.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let sample = textureLoad(sourceDepth, vec2<i32>(vec2<u32>(x, y)), 0);
      let valid = isFinite(sample) && sample > 0.0 && sample <= 1.0;
      farthestDepth = min(farthestDepth, select(0.0, sample, valid));
    }
  }
  let depth = linearizeViewDepth(farthestDepth);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}
