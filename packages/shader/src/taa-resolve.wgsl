#define_import_path forgeax_view::taa_resolve

#import forgeax_view::common::fullscreen_triangle
#import forgeax_view::common::FullscreenOutput

struct TaaResolveParams {
  currentJitterUv : vec2<f32>,
  historyValid : u32,
  temporalFrameIndex : u32,
};

struct TaaResolveOutput {
  @location(0) color : vec4<f32>,
  @location(1) temporal : vec4<f32>,
};

@group(0) @binding(0) var currentColor : texture_2d<f32>;
@group(0) @binding(1) var currentTemporal : texture_2d<f32>;
@group(0) @binding(2) var historyColor : texture_2d<f32>;
@group(0) @binding(3) var historyTemporal : texture_2d<f32>;
@group(0) @binding(4) var historySampler : sampler;
@group(0) @binding(5) var<uniform> params : TaaResolveParams;

fn rgbToYCoCg(rgb : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(rgb, vec3<f32>(0.25, 0.5, 0.25)),
    dot(rgb, vec3<f32>(0.5, 0.0, -0.5)),
    dot(rgb, vec3<f32>(-0.25, 0.5, -0.25)),
  );
}

fn yCoCgToRgb(value : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}

fn luminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn jitterCorrectedCurrent(uv : vec2<f32>) -> vec4<f32> {
  // The resolve and history live in the unjittered output domain. The main
  // scene raster is the only jittered consumer, so re-center its color here;
  // packed motion is already unjittered currentUv - previousUv.
  return textureSampleLevel(currentColor, historySampler, uv + params.currentJitterUv, 0.0);
}

fn closestCurrentTemporal(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec4<f32> {
  var closest = vec4<f32>(0.0, 0.0, -1.0, 1.0);
  var closestDepth = 1e20;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let samplePixel = clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1));
      let candidate = textureLoad(currentTemporal, samplePixel, 0);
      if candidate.z >= 0.0 && candidate.z < closestDepth {
        closest = candidate;
        closestDepth = candidate.z;
      }
    }
  }
  return closest;
}

@vertex
fn vs_taa_resolve(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

@fragment
fn fs_taa_resolve(in : FullscreenOutput) -> TaaResolveOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor));
  let pixel = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), dimensions - vec2<i32>(1));
  let current = jitterCorrectedCurrent(in.uv);
  let temporal = closestCurrentTemporal(pixel, dimensions);

  var output : TaaResolveOutput;
  output.temporal = temporal;
  output.color = current;

  let historyUv = in.uv - temporal.xy;
  let historyInBounds = all(historyUv >= vec2<f32>(0.0)) && all(historyUv < vec2<f32>(1.0));
  if params.historyValid == 0u || !historyInBounds || temporal.z < 0.0 {
    return output;
  }

  let previousTemporal = textureSampleLevel(historyTemporal, historySampler, historyUv, 0.0);
  let depthDelta = abs(previousTemporal.z - temporal.z);
  let depthThreshold = max(0.01, temporal.z * 0.01);
  if previousTemporal.z < 0.0 || depthDelta > depthThreshold {
    return output;
  }

  var neighborhoodMin = vec3<f32>(1e20);
  var neighborhoodMax = vec3<f32>(-1e20);
  var neighborhoodMean = vec3<f32>(0.0);
  var neighborhoodSquareMean = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sampleUv = in.uv + vec2<f32>(f32(x), f32(y)) / vec2<f32>(dimensions);
      let sampleValue = rgbToYCoCg(jitterCorrectedCurrent(sampleUv).rgb);
      neighborhoodMin = min(neighborhoodMin, sampleValue);
      neighborhoodMax = max(neighborhoodMax, sampleValue);
      neighborhoodMean += sampleValue;
      neighborhoodSquareMean += sampleValue * sampleValue;
    }
  }
  neighborhoodMean /= 9.0;
  neighborhoodSquareMean /= 9.0;
  let sigma = sqrt(max(neighborhoodSquareMean - neighborhoodMean * neighborhoodMean, vec3<f32>(0.0)));
  let clipMin = max(neighborhoodMin, neighborhoodMean - sigma * 1.25);
  let clipMax = min(neighborhoodMax, neighborhoodMean + sigma * 1.25);

  let sampledHistory = textureSampleLevel(historyColor, historySampler, historyUv, 0.0);
  let clippedHistoryRgb = yCoCgToRgb(clamp(rgbToYCoCg(sampledHistory.rgb), clipMin, clipMax));
  let velocityFactor = 1.0 - clamp(length(temporal.xy) * 64.0, 0.0, 1.0);
  let reactiveFactor = 1.0 - clamp(temporal.w, 0.0, 1.0);
  let depthFactor = 1.0 - clamp(depthDelta / depthThreshold, 0.0, 1.0);
  let currentLuma = luminance(current.rgb);
  let historyLuma = luminance(clippedHistoryRgb);
  let lumaDelta = abs(historyLuma - currentLuma);
  let unbiasedLumaDelta = clamp(lumaDelta / max(max(currentLuma, historyLuma), 0.2), 0.0, 1.0);
  let lumaFactor = (1.0 - unbiasedLumaDelta) * (1.0 - unbiasedLumaDelta);
  let fixedPresetWeight = mix(0.88, 0.97, lumaFactor);
  let startupWeight = f32(params.temporalFrameIndex) / f32(params.temporalFrameIndex + 1u);
  let progressiveWeight = select(fixedPresetWeight, min(startupWeight, fixedPresetWeight), params.temporalFrameIndex < 8u);
  let rejectionFactor = min(reactiveFactor, min(velocityFactor, depthFactor));
  let historyWeight = progressiveWeight * rejectionFactor;
  output.color = vec4<f32>(mix(current.rgb, clippedHistoryRgb, historyWeight), current.a);
  return output;
}
