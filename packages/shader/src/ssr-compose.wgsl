#define_import_path forgeax_ssr::compose
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}

struct ComposeVertex {
  @builtin(position) position : vec4<f32>,
};

@group(0) @binding(0) var radiance : texture_2d<f32>;
@group(0) @binding(1) var fallback : texture_2d<f32>;
@group(0) @binding(2) var response : texture_2d<f32>;
@group(0) @binding(3) var normalRoughness : texture_2d<u32>;
@group(0) @binding(4) var radianceSampler : sampler;
#import forgeax_view::common::View
@group(0) @binding(5) var<uniform> view : View;

struct SsrReceiverSample {
  radiance : vec4<f32>,
  coverage : f32,
};

@vertex
fn vs_ssr_compose(@builtin(vertex_index) index : u32) -> ComposeVertex {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return ComposeVertex(vec4<f32>(x, y, 0.0, 1.0));
}

// Reconstruct the half-resolution lattice without borrowing another face's
// ray. Renormalize compatible taps instead of rejecting the entire pixel
// solely because its nearest trace sample crossed a subpixel tile edge.
fn ssrReceiverSample(uv : vec2<f32>, normal : vec3<f32>) -> SsrReceiverSample {
  let size = vec2<i32>(textureDimensions(radiance, 0));
  let coordinate = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  var sum = vec4<f32>(0.0);
  var totalWeight = 0.0;
  let pixel00 = clamp(first + vec2<i32>(0, 0), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal00 = loadStandardNormalRoughness(normalRoughness, pixel00 * 2).xyz;
  let weight00 = select(1.0 - fraction.x, fraction.x, false) * select(1.0 - fraction.y, fraction.y, false)
    * ssrReceiverWeight(normal, tracedNormal00);
  // The presentation pyramid is premultiplied by confidence. Preserve
  // that representation during receiver reconstruction and unpremultiply
  // only once after the roughness filter has selected its LOD.
  let sample00 = textureLoad(radiance, pixel00, 0);
  sum += sample00 * weight00;
  totalWeight += weight00;

  let pixel10 = clamp(first + vec2<i32>(1, 0), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal10 = loadStandardNormalRoughness(normalRoughness, pixel10 * 2).xyz;
  let weight10 = select(1.0 - fraction.x, fraction.x, true) * select(1.0 - fraction.y, fraction.y, false)
    * ssrReceiverWeight(normal, tracedNormal10);
  let sample10 = textureLoad(radiance, pixel10, 0);
  sum += sample10 * weight10;
  totalWeight += weight10;

  let pixel01 = clamp(first + vec2<i32>(0, 1), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal01 = loadStandardNormalRoughness(normalRoughness, pixel01 * 2).xyz;
  let weight01 = select(1.0 - fraction.x, fraction.x, false) * select(1.0 - fraction.y, fraction.y, true)
    * ssrReceiverWeight(normal, tracedNormal01);
  let sample01 = textureLoad(radiance, pixel01, 0);
  sum += sample01 * weight01;
  totalWeight += weight01;

  let pixel11 = clamp(first + vec2<i32>(1, 1), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal11 = loadStandardNormalRoughness(normalRoughness, pixel11 * 2).xyz;
  let weight11 = select(1.0 - fraction.x, fraction.x, true) * select(1.0 - fraction.y, fraction.y, true)
    * ssrReceiverWeight(normal, tracedNormal11);
  let sample11 = textureLoad(radiance, pixel11, 0);
  sum += sample11 * weight11;
  totalWeight += weight11;
  return SsrReceiverSample(sum / max(totalWeight, 1e-6), totalWeight);
}

fn ssrReflectionLod(roughness : f32) -> f32 {
  return roughness * roughness * f32(textureNumLevels(radiance) - 1u);
}

fn sampleRoughSsr(uv : vec2<f32>, roughness : f32) -> vec4<f32> {
  let lod = ssrReflectionLod(roughness);
  // The presentation pyramid is premultiplied by confidence, so hardware
  // bilinear/trilinear filtering preserves coverage without the four manual
  // loads previously needed for every low-LOD sample.
  return textureSampleLevel(radiance, radianceSampler, uv, lod);
}

fn ssrReceiverWeight(current : vec3<f32>, traced : vec3<f32>) -> f32 {
  let agreement = dot(current, traced) * inverseSqrt(max(dot(current, current) * dot(traced, traced), 1e-8));
  return smoothstep(0.9, 0.99, agreement);
}

@fragment
fn fs_ssr_compose(in : ComposeVertex) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(in.position.xy);
  // Trace samples full-resolution pixel 2*p, not the center of a 2x2 box.
  let uv = (in.position.xy + vec2<f32>(0.5)) / vec2<f32>(textureDimensions(fallback, 0));
  let receiver = loadStandardNormalRoughness(normalRoughness, pixel);
  let environment = textureLoad(fallback, pixel, 0);
  let roughnessLimit = clamp(view.ssrParams.z, 0.0, 1.0);
  if (!(view.ssrParams.w > 0.5 && view.ssrParams.w < 3.402823e+38) ||
      !(receiver.a >= 0.0 && receiver.a < roughnessLimit) || environment.a <= 0.0) {
    return vec4<f32>(0.0);
  }
  let reconstructed = ssrReceiverSample(uv, receiver.xyz);
  if (reconstructed.coverage <= 1e-6) { return vec4<f32>(0.0); }
  let base = reconstructed.radiance;
  let roughness = clamp(receiver.a, 0.04, 1.0);
  let lod = ssrReflectionLod(roughness);
  var filtered = base;
  if (lod < 1.0) {
    // Preserve the normal-compatible receiver reconstruction at the sharp
    // end while using one hardware-filtered read for the first roughness mip.
    // This keeps the transition continuous at lod == 1 and avoids the four
    // explicit footprint loads used by the old mip helper.
    if (textureNumLevels(radiance) > 1u) {
      filtered = mix(base, textureSampleLevel(radiance, radianceSampler, uv, 1.0), lod);
    }
  } else {
    filtered = sampleRoughSsr(uv, roughness);
  }
  let sample = vec4<f32>(filtered.rgb / max(filtered.a, 1e-6), filtered.a);
  let materialResponse = textureLoad(response, pixel, 0).rgb;
  // Receiver admission is independent of the central mirror ray. A rough
  // lobe can contain a visible wall even when that one ray misses its edge.
  // Preserve the current material's cutoff instead of borrowing a neighbor's
  // roughness policy from the filtered reflection pyramid.
  let receiverConfidence = 1.0 - smoothstep(roughnessLimit * 0.8, roughnessLimit, receiver.a);
  let confidence = clamp(min(receiverConfidence, sample.a), 0.0, 1.0) * environment.a;
  return vec4<f32>(confidence * (sample.rgb * materialResponse - environment.rgb), 0.0);
}
