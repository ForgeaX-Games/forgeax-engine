#define_import_path forgeax_pbr::brdf

// @forgeax/engine-shader - brdf.wgsl (M5 T-18 feat-20260512-naga-oil-composition-hmr).
//
// Cook-Torrance BRDF helpers (D_GGX + V_SmithCorrelated + F_Schlick)
// extracted from pbr.wgsl via naga_oil #define_import_path / #import
// (D-04 moduleId convention). Pure helpers, no bindings, no state -
// safe to reuse from any material shader that needs microfacet specular.

fn d_ggx(nDotH : f32, a : f32) -> f32 {
  let a2 = a * a;
  let f = (nDotH * a2 - nDotH) * nDotH + 1.0;
  return a2 / (3.14159265 * f * f);
}

fn v_smith(nDotV : f32, nDotL : f32, a : f32) -> f32 {
  let a2 = a * a;
  let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

fn f_schlick(vDotH : f32, f0 : vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vDotH, 5.0);
}
