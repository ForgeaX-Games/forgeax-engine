#define_import_path forgeax_material::unlit
#import forgeax_view::common::{View, FogViewParams, FogRay, Mesh, InstanceData, view, meshes, instances, sampleMaterialTextureLinear, packSceneTemporal}
#import forgeax_view::fog::{apply_fog}

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE

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
//   @group(2) @binding(0) meshes                     storage   (see common.wgsl;
//                                                               normalMatrix not
//                                                               consumed in unlit)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// Material bindings are derived from the built-in paramSchema. Procedural
// geometry (M4) emits 12-floats vertex stride
// (pos+normal+uv+tangent); BUILTIN_CUBE / TRIANGLE keep 6-floats stride and
// route to a dedicated unlit pipeline branch wired by RenderSystem (M3 w22).
// This shader file consumes the 12-floats path; the 6-floats path is the
// vertex pipeline branch's responsibility.

struct Material {
  baseColor : vec4<f32>,
  alphaCutoff : f32,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;

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
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color : vec4<f32>,
#endif
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) worldPos : vec3<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
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
  out.worldPos = world.xyz;
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}

fn materialVertexColor(in : VsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

fn applySceneFog(viewParams : View, color : vec3<f32>, alpha : f32, worldPos : vec3<f32>) -> vec4<f32> {
  var origin = viewParams.cameraPos;
  var direction = normalize(worldPos - origin);
  var rayDistance = length(worldPos - origin);
  if (viewParams.temporalProjection.z >= 0.5) {
    let nearH = viewParams.inverseViewProj * vec4<f32>(0.0, 0.0, 0.0, 1.0);
    let farH = viewParams.inverseViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
    let nearPoint = nearH.xyz / nearH.w;
    let farPoint = farH.xyz / farH.w;
    direction = normalize(farPoint - nearPoint);
    origin = worldPos - direction * dot(worldPos - viewParams.cameraPos, direction);
    rayDistance = max(dot(worldPos - origin, direction), 0.0);
  }
  return apply_fog(viewParams.fog, FogRay(origin, direction, rayDistance), vec4<f32>(color, alpha));
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = materialVertexColor(in);
  let alpha = material.baseColor.a * texSample.a * vertexColor.a;
  if (material.alphaCutoff > 0.0 && alpha < material.alphaCutoff) {
    discard;
  }
  return applySceneFog(
    view,
    material.baseColor.rgb * texSample.rgb * vertexColor.rgb,
    alpha,
    in.worldPos,
  );
}

struct TemporalVsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(linear) currentClip : vec4<f32>,
  @location(2) @interpolate(linear) previousClip : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32) -> TemporalVsOut {
  let currentWorld =
    meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(in.pos, 1.0);
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(in.pos, 1.0);
#endif
  var out : TemporalVsOut;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = out.currentClip;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  out.uv = in.uv;
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}

fn temporalVertexColor(in : TemporalVsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = temporalVertexColor(in);
  let alpha = material.baseColor.a * texSample.a * vertexColor.a;
  if (material.alphaCutoff > 0.0 && alpha < material.alphaCutoff) {
    discard;
  }
  var reactive = 1.0;
#if STORAGE_BUFFER_AVAILABLE == true
  reactive = meshes[0].temporal.x;
#endif
  return packSceneTemporal(in.currentClip, in.previousClip, reactive);
}
