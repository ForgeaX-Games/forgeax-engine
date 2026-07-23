#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances, sampleMaterialTexture}

#pragma variant_axis STORAGE_BUFFER_AVAILABLE

// @forgeax/engine-shader - unlit.wgsl (M5 feat-20260511-asset-system-v1;
// refactored M5 T-18 feat-20260512-naga-oil-composition-hmr to pull View +
// Mesh via naga_oil #import; expanded feat-20260518-pbr-direct-lighting-mvp
// M2 / w8 to share binding 0-6 layout + 12-floats VsIn with pbr.wgsl).
//
// Minimal unlit material shader: world * view * proj transform + flat
// fragment output of `material.baseColor * sample(baseColorTexture)`. No
// lighting, no normal mapping, no metallic/roughness. Consumed by
// RenderSystem when the material dispatch tag resolves to 'unlit'
// (plan-strategy D-P4 / requirements AC-07). The pipeline binds:
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl;
//                                                               unlit only reads
//                                                               worldViewProj)
//   @group(1) @binding(0) material                   uniform   (vec4 baseColor;
//                                                               metallic/roughness
//                                                               unused on this path)
//   @group(1) @binding(1) baseColorSampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(1) @binding(3) metallicRoughnessSampler   sampler   (occupied by
//                                                               default linear
//                                                               sampler in unlit;
//                                                               not consumed)
//   @group(1) @binding(4) metallicRoughnessTexture   texture_2d<f32> (occupied
//                                                               by default 1x1
//                                                               white texture in
//                                                               unlit; not consumed)
//   @group(1) @binding(5) normalSampler              sampler   (default linear
//                                                               sampler; not
//                                                               consumed)
//   @group(1) @binding(6) normalTexture              texture_2d<f32> (default
//                                                               1x1 white texture;
//                                                               not consumed)
//   @group(2) @binding(0) meshes                     storage   (see common.wgsl;
//                                                               normalMatrix not
//                                                               consumed in unlit)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// Shared 0-6 binding layout mirrors pbr.wgsl byte-for-byte (D-4) so both
// pipelines can swap material BindGroup without re-creating BindGroupLayout
// per frame. Procedural geometry (M4) emits 12-floats vertex stride
// (pos+normal+uv+tangent); BUILTIN_CUBE / TRIANGLE keep 6-floats stride and
// route to a dedicated unlit pipeline branch wired by RenderSystem (M3 w22).
// This shader file consumes the 12-floats path; the 6-floats path is the
// vertex pipeline branch's responsibility.

struct Material {
  baseColor : vec4<f32>,
  metallic  : f32,
  roughness : f32,
  textureScalePadding : array<vec4<f32>, 3>,
  baseColorUvScale : vec2<f32>,
  metallicRoughnessUvScale : vec2<f32>,
  normalUvScale : vec2<f32>,
  emissiveUvScale : vec2<f32>,
  occlusionUvScale : vec2<f32>,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

// Preserve filtering reflection for the bound texture passed to the helper.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let baseWitness = textureSample(base, baseColorSampler, vec2<f32>(0.0));
}

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w5:
  // entity world from meshes[0] (dynamic-offset window), per-instance local
  // from instances[idx] (flat @group(3) buffer indexed by instance_index).
  // Combine: entity_world * per_instance_local.
  let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let texSample = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv, material.baseColorUvScale);
  return vec4<f32>(material.baseColor.rgb * texSample.rgb, material.baseColor.a * texSample.a);
}
