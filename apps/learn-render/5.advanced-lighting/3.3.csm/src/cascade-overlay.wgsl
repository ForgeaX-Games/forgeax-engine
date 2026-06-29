// apps/learn-render/5.advanced-lighting/3.3.csm/src/cascade-overlay.wgsl
// LearnOpenGL section 5.3 cascaded shadow maps -- demo-local cascade overlay
// debug-viz fullscreen pass (requirements OOS-4: heuristic, NOT a true shadow
// atlas tile readback).
//
// Tints the rendered scene by which PSSM cascade band a screen-space view ray
// falls into. The four split distances are the engine PSSM formula evaluated
// demo-side (cascadeCount=4, splitLambda=0.75, near=0.1, far=50 -- the same
// {cascadeCount, splitLambda, nearPlane, farPlane} spawned in main.ts), baked
// here as the SPLIT_* constants (cascade-overlay.ts asserts these match the
// recomputed values). The view-space depth of each screen direction is
// reconstructed by applying the inverse projection matrix to the pixel's NDC.
// The engine post-process fullscreen pass binds NO params UBO (group(0) is
// empty, group(1) is the scene texture + sampler), so the projection matrix is
// baked as a const and inverted in-shader via mat4_inverse(). No shadow-atlas
// frustum-fit / AABB math (heuristic per plan-strategy 5.3).
//
// TINT_MODE selects which cascades are highlighted (cascade-overlay.ts
// regex-swaps this single constant to build one pipeline variant per mode and
// hot-swaps via installPipeline on keys 1..4 / 0):
//   -1.0      = overlay OFF, passthrough the scene unchanged
//    0.0      = all four cascade bands tinted (default ON)
//    1.0..4.0 = highlight only cascade N, dim the other bands (keys 1..4)

struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var sceneTexture : texture_2d<f32>;
@group(1) @binding(1) var sceneSampler : sampler;

// Demo-side PSSM cascade far distances (view-space), splitLambda=0.75,
// near=0.1, far=50, cascadeCount=4.
const SPLIT_A : f32 = 3.498403;
const SPLIT_B : f32 = 7.939551;
const SPLIT_C : f32 = 17.311534;
const SPLIT_D : f32 = 50.000000;
const TINT_MODE : f32 = 0.0;
const TINT_STRENGTH : f32 = 0.45;

// Camera projection matrix (column-major: fov=PI/4, aspect=1, near=0.1,
// far=50, WebGPU 0..1 depth), baked at author time. Inverted in-shader so
// each screen pixel's NDC unprojects to a view-space direction.
fn projectionMatrix() -> mat4x4<f32> {
  return mat4x4<f32>(
    vec4<f32>(2.414214, 0.0, 0.0, 0.0),
    vec4<f32>(0.0, 2.414214, 0.0, 0.0),
    vec4<f32>(0.0, 0.0, -1.002004, -1.0),
    vec4<f32>(0.0, 0.0, -0.100200, 0.0),
  );
}

// Cofactor-expansion inverse of a 4x4 matrix (WGSL has no built-in inverse()).
fn mat4_inverse(m : mat4x4<f32>) -> mat4x4<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];

  let b00 = a00 * a11 - a01 * a10;
  let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11;
  let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30;
  let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31;
  let b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  let invDet = 1.0 / det;

  return mat4x4<f32>(
    vec4<f32>(
      (a11 * b11 - a12 * b10 + a13 * b09) * invDet,
      (a02 * b10 - a01 * b11 - a03 * b09) * invDet,
      (a31 * b05 - a32 * b04 + a33 * b03) * invDet,
      (a22 * b04 - a21 * b05 - a23 * b03) * invDet,
    ),
    vec4<f32>(
      (a12 * b08 - a10 * b11 - a13 * b07) * invDet,
      (a00 * b11 - a02 * b08 + a03 * b07) * invDet,
      (a32 * b02 - a30 * b05 - a33 * b01) * invDet,
      (a20 * b05 - a22 * b02 + a23 * b01) * invDet,
    ),
    vec4<f32>(
      (a10 * b10 - a11 * b08 + a13 * b06) * invDet,
      (a01 * b08 - a00 * b10 - a03 * b06) * invDet,
      (a30 * b04 - a31 * b02 + a33 * b00) * invDet,
      (a21 * b02 - a20 * b04 - a23 * b00) * invDet,
    ),
    vec4<f32>(
      (a11 * b07 - a10 * b09 - a12 * b06) * invDet,
      (a00 * b09 - a01 * b07 + a02 * b06) * invDet,
      (a31 * b01 - a30 * b03 - a32 * b00) * invDet,
      (a20 * b03 - a21 * b01 + a22 * b00) * invDet,
    ),
  );
}

// Per-band debug colors (cascade 0..3): green / yellow / orange / red, the
// canonical CSM debug palette (near cascades cool, far cascades warm).
fn cascadeColor(band : i32) -> vec3<f32> {
  if (band == 0) { return vec3<f32>(0.20, 0.85, 0.30); }
  if (band == 1) { return vec3<f32>(0.95, 0.85, 0.20); }
  if (band == 2) { return vec3<f32>(0.95, 0.55, 0.15); }
  return vec3<f32>(0.90, 0.25, 0.20);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, sceneSampler, in.uv).rgb;

  if (TINT_MODE < -0.5) {
    // Overlay OFF: passthrough the scene unchanged.
    return vec4<f32>(scene, 1.0);
  }

  // Reconstruct a view-space direction for this screen pixel from the inverse
  // projection matrix. NDC.xy at z=1 (far plane) unprojects to a view-space
  // point whose -z magnitude is the representative view depth of this screen
  // direction; map that through the PSSM split bands. Heuristic (OOS-4): this
  // is screen-direction depth, not per-pixel scene depth.
  let invProjection = mat4_inverse(projectionMatrix());
  let ndc = vec4<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0, 1.0, 1.0);
  let viewPos = invProjection * ndc;
  let viewDepth = abs(viewPos.z / viewPos.w);

  // Bucket the view depth into one of four PSSM cascade bands.
  var band : i32 = 3;
  if (viewDepth <= SPLIT_A) {
    band = 0;
  } else if (viewDepth <= SPLIT_B) {
    band = 1;
  } else if (viewDepth <= SPLIT_C) {
    band = 2;
  } else {
    band = 3;
  }

  let single = i32(round(TINT_MODE));
  let tint = cascadeColor(band);
  var amount = TINT_STRENGTH;
  if (single >= 1 && single <= 4) {
    // Single-cascade highlight mode: dim every band except the selected one.
    if (band != single - 1) {
      amount = TINT_STRENGTH * 0.15;
    }
  }

  let outColor = mix(scene, tint, amount);
  return vec4<f32>(outColor, 1.0);
}
