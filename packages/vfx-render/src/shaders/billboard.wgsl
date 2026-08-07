#define_import_path forgeax::vfx-render.particles.billboard

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
};

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) size: vec2<f32>,
  @location(2) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index];
  var output: VertexOutput;
  output.position = vec4<f32>(input.position.xy + corner * input.size, input.position.z, 1.0);
  output.color = input.color;
  output.local = corner;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // The quad is only a billboard carrier. Fade its signed local corner radius
  // into a disc so additive-looking aura particles cannot reveal a hard square.
  let edge = 1.0 - smoothstep(0.55, 1.0, length(input.local));
  let alpha = input.color.a * edge;
  // The particle PSO uses premultiplied-alpha blending.
  return vec4<f32>(input.color.rgb * alpha, alpha);
}
