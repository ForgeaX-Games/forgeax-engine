#define_import_path hello_multi_uv::multi_uv_demo
#pragma variant_axis M3_MULTI_UV_VARIANT

#import forgeax_view::common::{view, meshes, instances}

// multi-uv-demo.wgsl - feat-20260629-multi-uv-set-support AC-10 visual anchor.
//
// AC-10 per-set visual differentiation lives HERE, in the demo's own custom
// material shader, NOT in the engine-shipped default-standard-pbr.wgsl. The
// built-in PBR fragment must stay byte-identical for single-UV meshes
// (AC-11/AC-12 zero regression): clamp-to-last aliases an absent second UV
// set onto uv0, so a uv1-dependent term inside built-in PBR would silently
// darken every existing single-UV material. A demo shader is the legitimate
// place to sample uv1 for a visible pattern (AGENTS.md: demo-side
// differentiation, engine core untouched).
//
// Multi-UV pathway (D-4 numbering, identical to default-standard-pbr.wgsl):
//   VsIn  @location(6) uv1  -- second UV set, set 1 (set 0 stays @location(2))
//   VsOut @location(5) uv1  -- inter-stage varying to the fragment
// This is what makes naga's build-time @location reflection derive
// uvSetCount=2 for this shader, driving deriveVertexBufferLayout to bind the
// second UV set (clamp-to-last when a mesh has fewer sets).
//
// Visual rule: the fragment paints uv1 directly into the red/green channels
// (remapped to [0,1]). The procedural plane's uv1 is a per-quad checkerboard
// (0,0) vs (1,1), so the surface shows alternating dark/bright cells when the
// multi-UV pipeline feeds the second set. If uv1 collapses to uv0 (clamp) or
// the pipeline is broken, the checkerboard variance disappears -- the smoke's
// AC-10 falsification variant relies on this.

struct DemoUniforms {
  baseColor : vec4<f32>,
};

@group(1) @binding(0) var<uniform> demo : DemoUniforms;

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  // multi-uv D-4: second UV set at location 6 (set 0 stays at location 2).
  @location(6) uv1     : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) uv : vec2<f32>,
  // multi-uv D-4: second UV set inter-stage varying.
  @location(5) uv1 : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let instanceLocal = instances[idx].localFromInstance;
  let entityWorld = meshes[0].worldFromLocal;
  let world = entityWorld * instanceLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldPos = world.xyz;
  out.uv = in.uv;
  out.uv1 = in.uv1;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // Paint the second UV set into RG so the per-quad checkerboard becomes a
  // directly observable pattern (AC-10). uv1 in [0,1] maps straight to the
  // surface colour; the demo plane's (0,0)/(1,1) checkerboard renders as
  // alternating dark / bright cells modulated by the base tint.
  let pattern = vec3<f32>(in.uv1, 0.5);
#if M3_MULTI_UV_VARIANT == true
  let variantTint = vec3<f32>(1.0, 1.0, 1.0);
#else
  let variantTint = vec3<f32>(0.85, 1.0, 0.85);
#endif
  return vec4<f32>(demo.baseColor.rgb * pattern * variantTint, demo.baseColor.a);
}
