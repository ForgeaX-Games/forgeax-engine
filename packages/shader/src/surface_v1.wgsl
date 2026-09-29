#define_import_path forgeax_material::surface_v1

// Engine-owned input ABI for authored Standard material surfaces.
struct SurfaceInput {
  positionOS : vec3<f32>,
  positionWS : vec3<f32>,
  // Triangle orientation is independent of the interpolated shading basis.
  geometricNormalWS : vec3<f32>,
  vertexNormalWS : vec3<f32>,
  tangentWS : vec4<f32>,
  viewDirectionWS : vec3<f32>,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  uv2 : vec2<f32>,
  uv3 : vec2<f32>,
  uv4 : vec2<f32>,
  uv5 : vec2<f32>,
  uv6 : vec2<f32>,
  uv7 : vec2<f32>,
  vertexColor : vec4<f32>,
  frontFacing : bool,
  // Conservative UV diameters for explicit ray-cone filtering; raster uses derivatives.
  uvFootprint0 : vec4<f32>,
  uvFootprint1 : vec4<f32>,
};

// Surface output is consumed by the Standard BRDF and pass family.
struct SurfaceData {
  baseColor : vec3<f32>,
  normalWS : vec3<f32>,
  metallic : f32,
  roughness : f32,
  emissive : vec3<f32>,
  occlusion : f32,
  opacity : f32,
  alphaClipThreshold : f32,
};
