#define_import_path forgeax_view::hdrp_deferred_lighting

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::{View, FogViewParams, FogRay}
#import forgeax_view::common::fullscreen_triangle
#import forgeax_view::fog::{apply_fog}

// HDRP deferred lighting producer. The lighting pass consumes the material
// G-buffer and current-frame depth, reconstructs the fragment world position,
// then applies the shared analytic Fog exactly once to linear radiance.

@group(0) @binding(0) var<uniform> view : View;

@group(1) @binding(0) var gbufferAlbedo : texture_2d<f32>;
@group(1) @binding(1) var gbufferSampler : sampler;
@group(1) @binding(2) var<uniform> deferredParams : vec4<f32>;
@group(1) @binding(3) var sceneDepth : texture_depth_2d;
@group(1) @binding(4) var depthSampler : sampler;
@group(1) @binding(5) var gbufferNormal : texture_2d<f32>;
@group(1) @binding(6) var gbufferEmissive : texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

fn reconstructWorldPosition(uv : vec2<f32>, depth : f32) -> vec3<f32> {
  let clip = vec4<f32>(uv * 2.0 - vec2<f32>(1.0), depth, 1.0);
  let worldH = view.inverseViewProj * clip;
  return worldH.xyz / worldH.w;
}

fn fogDeferredRadiance(color : vec4<f32>, worldPos : vec3<f32>) -> vec4<f32> {
  var origin = view.cameraPos;
  var direction = normalize(worldPos - origin);
  var rayDistance = length(worldPos - origin);
  if (view.temporalProjection.z >= 0.5) {
    let nearH = view.inverseViewProj * vec4<f32>(0.0, 0.0, 0.0, 1.0);
    let farH = view.inverseViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
    let nearPoint = nearH.xyz / nearH.w;
    let farPoint = farH.xyz / farH.w;
    direction = normalize(farPoint - nearPoint);
    origin = worldPos - direction * dot(worldPos - view.cameraPos, direction);
    rayDistance = max(dot(worldPos - origin, direction), 0.0);
  }
  return apply_fog(view.fog, FogRay(origin, direction, rayDistance), color);
}

@fragment
fn fs_lighting(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // The lighting pass runs before the forward lane and shares its cleared
  // scene target. A far-depth sample is an empty G-buffer pixel; discard it
  // so deferred lighting preserves the existing clear/background contract.
  // Writing a synthetic material value here would cover forward-only scenes
  // (and change the HDRP baseline even when no deferred material is present).
  let depth = textureSampleLevel(sceneDepth, depthSampler, in.uv, 0);
  if (depth >= 0.999999) {
    discard;
  }
  let material = textureSampleLevel(gbufferAlbedo, gbufferSampler, in.uv, 0);
  let normalSample = textureSampleLevel(gbufferNormal, gbufferSampler, in.uv, 0);
  let emissiveSample = textureSampleLevel(gbufferEmissive, gbufferSampler, in.uv, 0);
  let normal = normalize(normalSample.xyz * 2.0 - vec3<f32>(1.0));
  let light = max(dot(normal, normalize(-view.lightDir)), 0.0);
  let direct = material.rgb * view.lightColor * light * clamp(emissiveSample.a, 0.0, 1.0);
  let radiance = vec4<f32>(direct + emissiveSample.rgb, material.a);
  let worldPos = reconstructWorldPosition(in.uv, depth);
  return fogDeferredRadiance(radiance, worldPos);
}
