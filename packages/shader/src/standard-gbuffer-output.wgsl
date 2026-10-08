#define_import_path forgeax_pbr::gbuffer_output
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardReflectance, STANDARD_GBUFFER_NO_RECEIVE_BIT}

// SceneColor owns emissive/opacity from the geometry pass onward. Five packed
// surface attachments cost 24 bytes/pixel; SceneColor remains linear HDR.
struct GBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) normal_roughness : u32,
  @location(2) f0_occlusion : u32,
  @location(3) albedo_metallic : u32,
  @location(4) lighting_context : u32,
  @location(5) receiver_geometry : vec2<u32>,
#ifdef VISIBLE_SURFACE_AVAILABLE
  // Frame row, draw-local primitive, packed geometric normal, coverage flags.
  @location(6) visible_surface : vec4<u32>,
  @location(7) scene_temporal : vec4<f32>,
#else
  // Optional attachment: the same shaded surface publishes temporal-v1.
  @location(6) scene_temporal : vec4<f32>,
#endif
};

fn encodeStandardGBuffer(normal : vec3<f32>, receiverNormal : vec3<f32>, roughness : f32, albedo : vec3<f32>,
  metallic : f32, f0 : vec3<f32>, occlusion : f32, emissive : vec3<f32>,
  opacity : f32, reflection : u32, probeRow : u32, receiveShadows : bool, receiverChannels : u32) -> GBufferOutput {
  var output : GBufferOutput;
  output.scene_color = vec4<f32>(emissive, opacity);
  output.receiver_geometry = vec2<u32>(encodeStandardNormalRoughness(receiverNormal, 0.0), receiverChannels);
  output.normal_roughness = encodeStandardNormalRoughness(normal, roughness);
  output.f0_occlusion = encodeStandardReflectance(f0, occlusion);
  output.albedo_metallic = encodeStandardReflectance(albedo, metallic);
  output.lighting_context = (reflection << 24u) | select(STANDARD_GBUFFER_NO_RECEIVE_BIT, 0u, receiveShadows) | probeRow;
  output.scene_temporal = vec4<f32>(0.0, 0.0, -1.0, 1.0);
  return output;
}
