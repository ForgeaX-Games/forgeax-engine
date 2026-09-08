#define_import_path forgeax::vfx-render.particles.mesh
#import forgeax_view::common::{View, FogViewParams, FogRay, view}
#import forgeax_view::fog::{apply_fog}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) emissive_intensity: vec4<f32>,
  @location(3) surface: vec4<f32>,
  @location(4) clip_position: vec3<f32>,
};

struct VertexInput {
  @location(0) geometry_position: vec3<f32>,
  @location(1) geometry_normal: vec3<f32>,
  @location(2) geometry_uv: vec2<f32>,
  @location(3) geometry_tangent: vec4<f32>,
  @location(4) center: vec3<f32>,
  @location(5) right: vec3<f32>,
  @location(6) up: vec3<f32>,
  @location(7) forward: vec3<f32>,
  @location(8) particle_color: vec4<f32>,
  @location(9) base_color: vec4<f32>,
  @location(10) emissive_intensity: vec4<f32>,
  @location(11) surface: vec4<f32>,
};

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
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let offset =
    input.right * input.geometry_position.x +
    input.up * input.geometry_position.y +
    input.forward * input.geometry_position.z;
  let clipPosition = input.center + offset;
  output.position = vec4<f32>(clipPosition, 1.0);
  output.clip_position = clipPosition;
  output.color = input.particle_color * input.base_color;
  output.normal = normalize(
    input.right * input.geometry_normal.x +
    input.up * input.geometry_normal.y +
    input.forward * input.geometry_normal.z
  );
  output.emissive_intensity = input.emissive_intensity;
  output.surface = input.surface;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let normal = normalize(input.normal);
  let light_direction = normalize(vec3<f32>(0.35, 0.7, 0.55));
  let view_direction = vec3<f32>(0.0, 0.0, 1.0);
  let half_direction = normalize(light_direction + view_direction);
  let diffuse = 0.2 + 0.8 * max(dot(normal, light_direction), 0.0);
  let metallic = clamp(input.surface.x, 0.0, 1.0);
  let roughness = clamp(input.surface.y, 0.04, 1.0);
  let clearcoat = clamp(input.surface.z, 0.0, 1.0);
  let clearcoat_roughness = clamp(input.surface.w, 0.04, 1.0);
  let specular_power = mix(96.0, 4.0, roughness);
  let coat_power = mix(192.0, 8.0, clearcoat_roughness);
  let specular = pow(max(dot(normal, half_direction), 0.0), specular_power);
  let coat = clearcoat * pow(max(dot(normal, half_direction), 0.0), coat_power);
  let dielectric = vec3<f32>(0.04);
  let specular_color = mix(dielectric, input.color.rgb, metallic);
  let lit = input.color.rgb * diffuse * (1.0 - metallic * 0.55);
  let emissive = input.emissive_intensity.rgb * input.emissive_intensity.a;
  let fogged = apply_fog(
    view.fog,
    fogRayFromNdc(input.clip_position),
    vec4<f32>(lit + specular_color * specular + vec3<f32>(coat) + emissive, input.color.a),
  );
  return vec4<f32>(fogged.rgb * fogged.a, fogged.a);
}
