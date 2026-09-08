#define_import_path forgeax_material::points_lines

// Portable triangle expansion for square/circle points and independent butt
// line-list segments. All dimensions are physical pixels; no native wide
// primitive state is required by any raster lane.

struct PointsLinesView {
  worldViewProj : mat4x4<f32>,
  model : mat4x4<f32>,
  physicalViewport : vec2<f32>,
  style : vec4<f32>,
};

@group(0) @binding(10) var<uniform> pointsLinesView : PointsLinesView;

struct PointsLinesMaterial {
  baseColor : vec4<f32>,
  alphaCutoff : f32,
  _materialPadding : vec3<f32>,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : PointsLinesMaterial;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;

struct PointsLinesVertex {
  @location(0) position : vec3<f32>,
  @location(1) otherPosition : vec3<f32>,
  @location(2) corner : vec2<f32>,
};

struct PointsLinesFragment {
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) shape : f32,
  @location(1) @interpolate(linear) sampleCenter : vec2<f32>,
};

fn clipPixelDelta(clip : vec4<f32>, pixels : vec2<f32>) -> vec2<f32> {
  let viewport = max(pointsLinesView.physicalViewport, vec2<f32>(1.0, 1.0));
  let ndcPerPixel = vec2<f32>(2.0 / viewport.x, -2.0 / viewport.y);
  return pixels * ndcPerPixel * clip.w;
}

fn expandPoint(position : vec3<f32>, corner : vec2<f32>, sizePx : f32) -> vec4<f32> {
  let clip = pointsLinesView.worldViewProj * pointsLinesView.model * vec4<f32>(position, 1.0);
  let offset = clipPixelDelta(clip, corner * (sizePx * 0.5));
  return vec4<f32>(clip.xy + offset, clip.z, clip.w);
}

fn expandLine(
  start : vec3<f32>,
  end : vec3<f32>,
  corner : vec2<f32>,
  widthPx : f32,
) -> vec4<f32> {
  let startClip = pointsLinesView.worldViewProj * pointsLinesView.model * vec4<f32>(start, 1.0);
  let endClip = pointsLinesView.worldViewProj * pointsLinesView.model * vec4<f32>(end, 1.0);
  let startNdc = startClip.xy / max(startClip.w, 0.000001);
  let endNdc = endClip.xy / max(endClip.w, 0.000001);
  let tangent = endNdc - startNdc;
  let safeTangent = select(vec2<f32>(1.0, 0.0), tangent, dot(tangent, tangent) > 0.0000001);
  let axis = normalize(safeTangent);
  let normal = vec2<f32>(-axis.y, axis.x);
  let endpoint = select(startClip, endClip, corner.x > 0.0);
  let offset = clipPixelDelta(endpoint, normal * corner.y * (widthPx * 0.5));
  // butt line-list: each segment owns exactly its two endpoint positions.
  return vec4<f32>(endpoint.xy + offset, endpoint.z, endpoint.w);
}

fn circleCoverage(sampleCenter : vec2<f32>) -> bool {
  return dot(sampleCenter, sampleCenter) <= 1.0;
}

@vertex
fn vs_main(input : PointsLinesVertex) -> PointsLinesFragment {
  let isLine = pointsLinesView.style.y > 0.5;
  let isCircle = pointsLinesView.style.z > 0.5 && !isLine;
  var output : PointsLinesFragment;
  output.position = select(
    expandPoint(input.position, input.corner, pointsLinesView.style.x),
    expandLine(input.position, input.otherPosition, input.corner, pointsLinesView.style.x),
    isLine,
  );
  output.shape = select(0.0, 1.0, isCircle);
  output.sampleCenter = select(input.corner, vec2<f32>(0.0, 0.0), isLine);
  return output;
}

@fragment
fn fs_main(input : PointsLinesFragment) -> @location(0) vec4<f32> {
  if input.shape > 0.5 && !circleCoverage(input.sampleCenter) {
    discard;
  }
  let uv = material.baseColorTextureCoordinatesMetadata.xy;
  let textureColor = textureSample(baseColorTexture, baseColorSampler, uv);
  let color = material.baseColor * textureColor;
  if material.alphaCutoff > 0.0 && color.a < material.alphaCutoff {
    discard;
  }
  return color;
}
