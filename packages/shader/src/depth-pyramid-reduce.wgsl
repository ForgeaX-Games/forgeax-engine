#define_import_path forgeax_depth_pyramid::reduce

// Depth pyramid reduction consumes the previous r32float mip.  It is deliberately a
// separate module from the depth seed: WebGPU depth sample types cannot bind
// an r32float view, while the seed must retain the depth-only binding.
const DEPTH_PYRAMID_EMPTY_DEPTH : f32 = 3.402823e+38;

@group(0) @binding(0) var sourcePyramid : texture_2d<f32>;
@group(0) @binding(1) var pyramidOutput : texture_storage_2d<r32float, write>;

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn normalizeDepthPyramidDepth(value : f32) -> f32 {
  return select(DEPTH_PYRAMID_EMPTY_DEPTH, value, isFinite(value) && value > 0.0);
}

// Physical WebGPU mip dimensions are floor-halved. Partition the source by
// integer normalized boundaries and ceil the end boundary so adjacent
// footprints overlap at odd boundaries; a 3-wide source reduced to one texel
// must inspect all three source texels rather than a clamped 2x2 prefix.
fn reduceDepthPyramidFootprint(
  destinationCoordinate : vec2<u32>,
  sourceSize : vec2<u32>,
  destinationSize : vec2<u32>,
  furthest : bool,
) -> f32 {
  let sourceStart = destinationCoordinate * sourceSize / destinationSize;
  let sourceEnd = min(
    ((destinationCoordinate + vec2<u32>(1u)) * sourceSize + destinationSize -
      vec2<u32>(1u)) / destinationSize,
    sourceSize,
  );
  var reduced = select(DEPTH_PYRAMID_EMPTY_DEPTH, 0.0, furthest);
  for (var y = sourceStart.y; y < sourceEnd.y; y += 1u) {
    for (var x = sourceStart.x; x < sourceEnd.x; x += 1u) {
      let depth = normalizeDepthPyramidDepth(textureLoad(sourcePyramid, vec2<i32>(vec2<u32>(x, y)), 0).r);
      reduced = select(min(reduced, depth), max(reduced, depth), furthest);
    }
  }
  return reduced;
}

@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_reduce(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourcePyramid, 0);
  let destinationSize = textureDimensions(pyramidOutput);
  if (globalId.x >= destinationSize.x || globalId.y >= destinationSize.y) {
    return;
  }
  let reduced = reduceDepthPyramidFootprint(globalId.xy, sourceSize, destinationSize, false);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(reduced, 0.0, 0.0, 1.0));
}

// The occlusion variant keeps the farthest covered depth so a coarse texel
// never claims to occlude more than every finer texel beneath it.
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_reduce_furthest(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourcePyramid, 0);
  let destinationSize = textureDimensions(pyramidOutput);
  if (globalId.x >= destinationSize.x || globalId.y >= destinationSize.y) {
    return;
  }
  let reduced = reduceDepthPyramidFootprint(globalId.xy, sourceSize, destinationSize, true);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(reduced, 0.0, 0.0, 1.0));
}
