#define_import_path forgeax::vfx-render.particles.beam
#import forgeax_view::common::{View, FogViewParams, FogRay, view}
#import forgeax_view::fog::{apply_fog}

struct BeamInput {
  @location(0) start: vec3<f32>,
  @location(1) endpoint: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) properties: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) clip_position: vec3<f32>,
}

fn fogWorldPoint(ndc: vec3<f32>) -> vec3<f32> {
  let homogeneous = view.inverseViewProj * vec4<f32>(ndc, 1.0);
  let divisor = select(1.0, homogeneous.w, abs(homogeneous.w) > 0.000001);
  return homogeneous.xyz / divisor;
}

fn fogRayFromNdc(ndc: vec3<f32>) -> FogRay {
  let worldPosition = fogWorldPoint(ndc);
  let nearPosition = fogWorldPoint(vec3<f32>(ndc.xy, 0.0));
  let farPosition = fogWorldPoint(vec3<f32>(ndc.xy, 1.0));
  let perspective = view.temporalProjection.z < 0.5;
  let perspectiveVector = worldPosition - view.cameraPos;
  let orthographicVector = farPosition - nearPosition;
  let direction = normalize(select(orthographicVector, perspectiveVector, perspective));
  let origin = select(nearPosition, view.cameraPos, perspective);
  let ray_distance = select(
    max(dot(worldPosition - nearPosition, direction), 0.0),
    length(perspectiveVector),
    perspective,
  );
  return FogRay(origin, direction, ray_distance);
}

@vertex
fn vs_main(input: BeamInput, @builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let corner = corners[vertexIndex];
  let delta = input.endpoint.xy - input.start.xy;
  let normal = normalize(vec2<f32>(-delta.y, delta.x) + vec2<f32>(0.000001, 0.0));
  let point = mix(input.start, input.endpoint, corner.x);
  let clipPosition = vec3<f32>(point.xy + normal * corner.y * input.properties.x, point.z);
  var output: VertexOutput;
  output.position = vec4<f32>(clipPosition, 1.0);
  output.color = input.color;
  output.clip_position = clipPosition;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let base = vec4<f32>(0.7, 0.2, 1.0, 1.0);
  let alpha = base.a * input.color.a;
  let fogged = apply_fog(
    view.fog,
    fogRayFromNdc(input.clip_position),
    vec4<f32>(base.rgb * input.color.rgb, alpha),
  );
  return vec4<f32>(fogged.rgb * fogged.a, fogged.a);
}
