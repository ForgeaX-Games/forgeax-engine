struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

struct FogParams {
  mode : f32,
  startOrDensity : f32,
  end : f32,
  _pad : f32,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@group(1) @binding(0) var sceneTexture : texture_2d<f32>;
@group(1) @binding(1) var sceneSampler : sampler;
@group(1) @binding(2) var<uniform> params : FogParams;
@group(1) @binding(3) var depthTexture : texture_depth_2d;
@group(1) @binding(4) var depthSampler : sampler;

const FOG_COLOR : vec3<f32> = vec3<f32>(0.25, 0.25, 0.25);
const CAMERA_NEAR : f32 = 0.1;
const CAMERA_FAR : f32 = 80.0;

fn linearViewDepth(ndcDepth : f32) -> f32 {
  return CAMERA_NEAR * CAMERA_FAR /
    (CAMERA_FAR - ndcDepth * (CAMERA_FAR - CAMERA_NEAR));
}

fn fogAmount(viewDepth : f32) -> f32 {
  if (params.mode < 0.5) {
    return clamp((viewDepth - params.startOrDensity) / (params.end - params.startOrDensity), 0.0, 1.0);
  }
  if (params.mode < 1.5) {
    return 1.0 - exp(-params.startOrDensity * viewDepth);
  }
  let scaledDepth = params.startOrDensity * viewDepth;
  return 1.0 - exp(-(scaledDepth * scaledDepth));
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, sceneSampler, in.uv).rgb;
  let ndcDepth = textureSample(depthTexture, depthSampler, in.uv);
  let viewDepth = linearViewDepth(ndcDepth);
  let amount = select(fogAmount(viewDepth), 1.0, ndcDepth >= 0.9999);
  return vec4<f32>(mix(scene, FOG_COLOR, amount), 1.0);
}
