#pragma variant_axis STORAGE_BUFFER_AVAILABLE

// @forgeax/engine-shader shadow_caster.wgsl
// feat-20260520-directional-light-shadow-mapping M1c / w9 (D-9 / AC-09):
// vertex-only depth pass for directional shadow map. No fragment stage --
// the GPU writes depth automatically from gl_Position.z (depth32float RT).
//
// feat-20260613-csm-cascaded-shadow-maps M5 / w28: per-cascade
// lightViewProj selection. Each cascade pass writes a different
// `shadowCasterCascade.index` (0..3) before encoder submit; the vertex
// shader reads it to pick `view.lightViewProj_A..D`. The atlas tile UV
// inset is already baked into each lightViewProj host-side
// (render-system-extract.ts), so the per-cascade viewport on the depth
// pass clips rasterization to the correct atlas tile while the matrix
// itself maps NDC straight into atlas-space [0,1]^2.
//
// Reuses:
//   @group(0) binding(0) view : View                 -- common.wgsl
//   @group(0) binding(5) shadowCasterCascade         -- common.wgsl
//   @group(2) binding(0) meshes : array<Mesh>        -- common.wgsl
//   @group(3) binding(0) instances : array<InstanceData>  -- common.wgsl
//
// Vertex layout: matches the 12F procedural layout of every mesh
// (position vec3, normal vec3, uv vec2, tangent vec4; 48 B stride).

#import forgeax_view::common::{View, Mesh, InstanceData, ShadowCasterCascade, view, shadowCasterCascade, meshes, instances}

struct VsInput {
  @location(0) position : vec3<f32>,
};

fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> @builtin(position) vec4<f32> {
  let worldPos = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(in.position, 1.0);
  let lvp = _cascadeLightViewProj(shadowCasterCascade.index);
  return lvp * worldPos;
}
