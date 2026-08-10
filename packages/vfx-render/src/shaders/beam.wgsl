#define_import_path forgeax::vfx-render.particles.beam

struct BeamInput {
  @location(0) start: vec3<f32>,
  @location(1) endpoint: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) properties: vec2<f32>,
}

@vertex
fn vs_main(input: BeamInput, @builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let corner = corners[vertexIndex];
  let delta = input.endpoint.xy - input.start.xy;
  let normal = normalize(vec2<f32>(-delta.y, delta.x) + vec2<f32>(0.000001, 0.0));
  let point = mix(input.start, input.endpoint, corner.x);
  return vec4<f32>(point.xy + normal * corner.y * input.properties.x, point.z, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.7, 0.2, 1.0, 1.0);
}
