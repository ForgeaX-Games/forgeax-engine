#define_import_path forgeax_pbr::tbn

// @forgeax/engine-shader - tbn.wgsl (feat-20260523-shader-template-instance-split
// M5 / T01).
//
// Tangent-space normal decode + TBN basis composition helpers extracted from
// pbr.wgsl fs_main body. Pure-function module (zero @group / @binding) so it
// composes cleanly into any material shader that wants tangent-space normal
// mapping with the host's per-vertex tangent (vec4 with handedness in .w).
//
// RG-only tangent normal decode mirrors pbr.wgsl pre-split semantics
// (charter P5 byte-equivalent extraction). The default 1x1 normal fallback
// texture RG=(128,128) decodes to tangent (0,0,1) -- zero perturbation when
// normalTexture is absent (host-side defaultNormalTextureView). RG encoding
// also matches BC5 / RG normal maps and tolerates RGB normal maps (b is
// dropped, z is recomputed -- equivalent for unit vectors).
//
// Exports:
//   - decodeTangentSpaceNormalRg(rg)          -> vec3<f32>  (pure)
//   - applyTBN(worldNormal, worldTangent, tn) -> vec3<f32>  (pure)

// Decode a tangent-space normal from the RG channels of a normal-map sample.
// Z is reconstructed via z = sqrt(saturate(1 - x^2 - y^2)); saturate guards
// against numerically-out-of-unit (x,y) producing NaN.
fn decodeTangentSpaceNormalRg(rg: vec2<f32>) -> vec3<f32> {
  let xy = rg * 2.0 - vec2<f32>(1.0);
  let z = sqrt(saturate(1.0 - dot(xy, xy)));
  return vec3<f32>(xy, z);
}

// Build the TBN basis from interpolated world-space normal + per-vertex
// tangent (xyz with handedness sign in .w), then transform a tangent-space
// normal `tn` into world-space. Re-normalises the input world normal +
// re-orthogonalises the tangent against the normal so that small interpolation
// drift across triangle barycentrics does not skew the basis.
fn applyTBN(
  worldNormal  : vec3<f32>,
  worldTangent : vec4<f32>,
  tn           : vec3<f32>,
) -> vec3<f32> {
  let n0 = normalize(worldNormal);
  let t0 = normalize(worldTangent.xyz - dot(worldTangent.xyz, n0) * n0);
  let b0 = cross(n0, t0) * worldTangent.w;
  return normalize(t0 * tn.x + b0 * tn.y + n0 * tn.z);
}
