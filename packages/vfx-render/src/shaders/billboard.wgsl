#define_import_path forgeax::vfx-render.particles.billboard

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) emissive_intensity: vec4<f32>,
  @location(3) surface: vec4<f32>,
};

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particle_color: vec4<f32>,
  @location(4) base_color: vec4<f32>,
  @location(5) emissive_intensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index];
  var output: VertexOutput;
  output.position = vec4<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
    1.0,
  );
  output.color = input.particle_color * input.base_color;
  output.local = corner;
  output.emissive_intensity = input.emissive_intensity;
  output.surface = input.surface;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let radius = length(input.local);
  let edge = 1.0 - smoothstep(0.45, 1.0, radius);
  let core = 1.0 - smoothstep(0.0, 0.42, radius);
  let roughness = clamp(input.surface.y, 0.04, 1.0);
  let clearcoat = clamp(input.surface.z, 0.0, 1.0);
  let highlight = core * clearcoat * (1.0 - roughness * 0.65);
  let emissive = input.emissive_intensity.rgb * input.emissive_intensity.a;
  let alpha = input.color.a * edge;
  let rgb = input.color.rgb + emissive * (0.35 + core * 0.65) + vec3<f32>(highlight);
  return vec4<f32>(rgb * alpha, alpha);
}
