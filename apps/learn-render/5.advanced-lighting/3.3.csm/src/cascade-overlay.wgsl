// apps/learn-render/5.advanced-lighting/3.3.csm/src/cascade-overlay.wgsl
// LearnOpenGL section 5.3 cascaded shadow maps -- demo-local cascade overlay
// debug-viz fullscreen pass.
//
// feat-20260702-postprocess-camera-depth-read M4 w16: rewrite from compile-time
// TINT_MODE + mat4_inverse fake-depth to engine-depth-channel read via
// fullscreen-post-with-scene-depth BGL kind (depthTex@3 + non-filtering
// depthSampler@4) + uniform params@2 (tintMode / fakeDepth fields).
//
// The shader reads real scene depth from the camera depth buffer, converts
// from NDC [0,1] to linear view-space depth, and buckets into four PSSM
// cascade bands. The fakeDepth param (>0.5) restores the old far-plane NDC
// path (band 3 red everywhere) for FALSIFY smoke verification (AC-07c).

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
@group(1) @binding(2) var<uniform> p : PostProcessParams;
@group(1) @binding(3) var depthTex : texture_depth_2d;
@group(1) @binding(4) var depthSampler : sampler;

struct PostProcessParams {
  tintMode: f32,
  fakeDepth: f32,
  _pad: vec2<f32>,
}

// PSSM cascade far distances (view-space). Computed with splitLambda=0.75,
// near=0.1, far=50, cascadeCount=4 -- matches the engine PSSM formula used
// by DirectionalLight with shadowDistance=50.
const SPLIT_A : f32 = 3.498403;
const SPLIT_B : f32 = 7.939551;
const SPLIT_C : f32 = 17.311534;
const SPLIT_D : f32 = 50.000000;

const TINT_STRENGTH : f32 = 0.45;

// Camera near/far for NDC depth linearisation. Must match main.ts
// CAMERA_NEAR=0.1 / CAMERA_FAR=50.0.
const CAMERA_NEAR : f32 = 0.1;
const CAMERA_FAR : f32 = 50.0;

// Per-band debug tint colours (cascade 0..3): green / yellow / orange / red.
fn cascadeColor(band : i32) -> vec3<f32> {
  if (band == 0) { return vec3<f32>(0.20, 0.85, 0.30); }
  if (band == 1) { return vec3<f32>(0.95, 0.85, 0.20); }
  if (band == 2) { return vec3<f32>(0.95, 0.55, 0.15); }
  return vec3<f32>(0.90, 0.25, 0.20);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, sceneSampler, in.uv).rgb;

  if (p.tintMode < -0.5) {
    // Overlay OFF: passthrough the scene unchanged.
    return vec4<f32>(scene, 1.0);
  }

  // Read real scene depth from camera depth buffer via the engine's depth
  // channel (D-2: raw depth-value read with a non-filtering sampler --
  // textureSample here; textureSampleLevel is equally valid on texture_depth_2d,
  // cf. hdrp-ssao.wgsl. Not textureSampleCompare, which does PCF comparison).
  //
  // fakeDepth > 0.5 restores the pre-M4 far-plane NDC path -- every pixel
  // falls in band 3 (red), reproducing the old behaviour exactly for the
  // FALSIFY smoke gate (AC-07c).
  var viewDepth : f32;
  if (p.fakeDepth > 0.5) {
    viewDepth = CAMERA_FAR;
  } else {
    let ndcDepth = textureSample(depthTex, depthSampler, in.uv);
    // Convert NDC [0,1] depth to linear view-space depth.
    // Derivation from the WebGPU perspective projection matrix
    //   z_ndc = far/(far-near) - near*far/((far-near) * viewDepth)
    //   => viewDepth = near * far / (far - z_ndc * (far - near))
    let NEAR_TIMES_FAR = CAMERA_NEAR * CAMERA_FAR;
    let FAR_MINUS_NEAR = CAMERA_FAR - CAMERA_NEAR;
    viewDepth = NEAR_TIMES_FAR / (CAMERA_FAR - ndcDepth * FAR_MINUS_NEAR);
  }

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

  let single = i32(round(p.tintMode));
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