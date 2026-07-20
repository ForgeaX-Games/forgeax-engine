#define_import_path learn_render::5_1_blinn_phong

#import forgeax_view::common::{View, Mesh, view, meshes}

// blinn-phong.wgsl — LO 5.1 Blinn-Phong per-fragment shading.
//
// Implements the classic Blinn-Phong reflection model using the half-vector
// approximation (H = normalize(L + V)) for specular highlights.
//
// Formula (1:1 translation of LO 5.1 cpp):
//   ambient  = 0.05 * lightColor
//   diffuse  = max(dot(N, L), 0.0) * lightColor
//   specular = pow(max(dot(N, H), 0.0), shininess) * lightColor
//   H = normalize(V + L)
//   color = (ambient + diffuse + specular) * textureSample(diffuseTexture, uv).rgb
//
// Constants are inlined (light position, color, shininess); `viewPos`
// is read from the engine View UBO (`view.cameraPos`). Engine PBR
// reserves @group(1) @binding(7..17) for Skylight + emissive/AO
// (pbr-pipeline.ts buildPbrPipelineLayouts), so user shaders MUST NOT
// declare additional bindings in @group(1) above 6 — the BindGroup
// layout is shared with the engine's standard PBR pipeline and a
// new binding would collide with the irradianceMap (binding 7).

struct Material {
  baseColor : vec4<f32>,
  metallic  : f32,
  roughness : f32,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

// LO 5.1 constants — the demo never animates these, so they live in
// the shader as `const` rather than a binding(7) UBO.
const LIGHT_POS   : vec3<f32> = vec3<f32>(0.0, 0.0, 0.0);
const LIGHT_COLOR : vec3<f32> = vec3<f32>(1.0, 1.0, 1.0);
const SHININESS   : f32       = 32.0;

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip        : vec4<f32>,
  @location(0)       worldPos    : vec3<f32>,
  @location(1)       worldNormal : vec3<f32>,
  @location(2)       uv          : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldPos = world.xyz;
  out.worldNormal = normalize(meshes[idx].normalMatrix * in.normal);
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let N = normalize(in.worldNormal);
  let V = normalize(view.cameraPos - in.worldPos);
  let L = normalize(LIGHT_POS - in.worldPos);
  let H = normalize(V + L);

  let ambient = 0.05 * LIGHT_COLOR;
  let diff = max(dot(N, L), 0.0) * LIGHT_COLOR;
  let spec = pow(max(dot(N, H), 0.0), SHININESS) * LIGHT_COLOR;

  let texColor = textureSample(baseColorTexture, baseColorSampler, in.uv).rgb;
  let result = (ambient + diff + spec) * texColor;

  return vec4<f32>(result, 1.0);
}
