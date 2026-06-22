// hdrp-ssao.wgsl — HDRP Screen-Space Ambient Occlusion.
// feat-20260612-hdrp-ssao M2 / w8.
//
// Two fullscreen fragment passes following LO 5.9:
//   fs_ssao_calc — 64-sample hemisphere SSAO with range check, writes R8 scalar.
//   fs_ssao_blur — 4x4 box blur (16 tap), reads ssaoRaw, writes R8 scalar.
//
// plan-strategy D-1: SSAO owns its uniform group (@group(2)) with view +
//   projection + inverseProjection (3 mat4, 192 B UBO). Does NOT read View UBO.
// plan-strategy D-2: exactly 2 pass, no H/V split.
// requirements OOS-3: 4x4 box blur only; no depth-aware/bilateral.
// requirements OOS-4: no depth-reconstruction path for normals; reads normal from
//   g-buffer RT0 (packed world-space normal, 0.5*n+0.5 in rgba16f).
//
// BGL layout (@group(0), SSAO-dedicated; w37 expansion for D-A/D-D + dawn fix):
//   @binding(0) var<uniform> ssao_uniform : SsaoUniform   (256 B UBO)
//   @binding(1) var<storage, read> ssao_kernel : array<vec3<f32>,64>  (1024 B SSBO)
//   @binding(2) var ssao_noise_texture : texture_2d<f32>  (4x4 rgba32float)
//   @binding(3) var ssao_noise_sampler : sampler          (filtering, for noise tile)
//   @binding(4) var gbuffer_normal : texture_2d<f32>      (RT0, packed world normal)
//   @binding(5) var hdr_depth : texture_depth_2d          (hardware depth)
//   @binding(6) var ssao_depth_sampler : sampler          (non-filtering, for hdr_depth)
//   @binding(7) var ssaoRaw : texture_2d<f32>             (half-res calc output, blur input)
//   @binding(8) var ssaoSampler : sampler                 (filtering, for ssaoRaw)
//
// Sampler split (w37 dawn-blocker fix): WebGPU validation requires depth
// textures (sampleType=depth) to be sampled with non-filtering or comparison
// samplers, not filtering. Pre-w37 the BGL had a single `filtering` sampler at
// binding 3 paired with hdr_depth at binding 5, which crashed every HDRP PSO
// build on dawn. ssao_depth_sampler at binding 6 is the non-filtering sampler
// dedicated to hdr_depth; ssao_noise_sampler at binding 3 stays filtering for
// the float noise/normal textures.
//
// fs_ssao_calc: reads g-buffer normal + hdrDepth, writes half-res R8.
// fs_ssao_blur: reads ssaoRaw (half-res R8), writes half-res R8 (D-D fix:
//   pre-w37 blur erroneously read gbuffer_normal — copy-paste typo from
//   fs_ssao_calc).
//
// Vertex stage: both passes use fullscreen_triangle from common.wgsl.
//
// Research F1-F6 (LO 5.9 GLSL -> WGSL translation), KB ref:
//   .forgeax-harness/knowledge-base/references/repos/learnopengl/src/5.advanced_lighting/9.ssao/

#define_import_path forgeax_hdrp::ssao

#import forgeax_view::common::{fullscreen_triangle, FullscreenOutput}

// ── SSAO uniform (3 mat4 + vec4 intensityPad, 256 B, D-1 + D-C) ─────────────
//
// intensityPad.x carries the SSAO intensity scalar at host write time, but
// the SSAO compute shaders themselves do not read it; the lighting shader
// reads intensity from `cluster_uniform.near_far_log.w` (HDRP unified BGL
// @group(2) @binding(6)) after scope-amend-webgl2-ubo folded the dedicated
// @binding(9) into the cluster pad lane. The vec4 is kept here so the UBO
// stays 256 B aligned and the host write site (single 256 B writeBuffer)
// remains unchanged.

struct SsaoUniform {
  view              : mat4x4<f32>,  // world -> view
  projection        : mat4x4<f32>,  // view -> clip
  inverseProjection : mat4x4<f32>,  // NDC -> view
  intensityPad      : vec4<f32>,    // x = intensity, yzw padding
};

// ── SSAO binding declarations (@group(2)) ───────────────────────────────────

@group(0) @binding(0) var<uniform> ssao_uniform      : SsaoUniform;
@group(0) @binding(1) var<storage, read> ssao_kernel  : array<vec3<f32>, 64>;
@group(0) @binding(2) var ssao_noise_texture          : texture_2d<f32>;
@group(0) @binding(3) var ssao_noise_sampler          : sampler;
@group(0) @binding(4) var gbuffer_normal              : texture_2d<f32>;
@group(0) @binding(5) var hdr_depth                   : texture_depth_2d;
@group(0) @binding(6) var ssao_depth_sampler          : sampler;
@group(0) @binding(7) var ssaoRaw                     : texture_2d<f32>;
@group(0) @binding(8) var ssaoSampler                 : sampler;

// ── vertex: fullscreen triangle (SSOT in common.wgsl) ───────────────────────

struct SsaoVsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv             : vec2<f32>,
};

@vertex
fn vs_ssao(@builtin(vertex_index) vertex_index : u32) -> SsaoVsOut {
  let ft = fullscreen_triangle(vertex_index);
  var out : SsaoVsOut;
  out.position = ft.position;
  out.uv = ft.uv;
  return out;
}

// ── fs_ssao_calc: 64-sample hemisphere SSAO (LO 5.9) ────────────────────────

@fragment
fn fs_ssao_calc(in : SsaoVsOut) -> @location(0) f32 {
  // Reconstruct view-space position from depth + NDC.
  let depth = textureSampleLevel(hdr_depth, ssao_depth_sampler, in.uv, 0);
  // NDC reconstruction: screen-space xy in [-1,1], depth in [0,1].
  let ndc = vec4<f32>(in.uv * 2.0 - 1.0, depth, 1.0);
  // Transform NDC -> view via inverse projection.
  var viewPosH = ssao_uniform.inverseProjection * ndc;
  viewPosH = viewPosH / viewPosH.w;
  let viewPos = viewPosH.xyz;

  // Read and unpack world-space normal from g-buffer RT0.
  let packedNormal = textureSample(gbuffer_normal, ssao_noise_sampler, in.uv).rgb;
  let worldNormal = normalize(packedNormal * 2.0 - 1.0);

  // Rotate world normal to view-space.
  let viewNormal = normalize((ssao_uniform.view * vec4<f32>(worldNormal, 0.0)).xyz);

  // Read noise for per-pixel TBN rotation.
  let noiseScale = vec2<f32>(textureDimensions(ssao_noise_texture, 0)) / 4.0;
  // Actually: scale factor is screenDim / noiseDim. Use a fixed factor for half-res.
  // The noise texture is 4x4 and tiled via REPEAT sampling.
  let screenDim = vec2<f32>(textureDimensions(gbuffer_normal, 0));
  let noiseUV = in.uv * screenDim / 4.0;
  let randomVec = normalize(textureSample(ssao_noise_texture, ssao_noise_sampler, noiseUV).xyz);

  // TBN: Gram-Schmidt orthonormalization (tangent-space -> view-space).
  let tangent = normalize(randomVec - viewNormal * dot(randomVec, viewNormal));
  let bitangent = cross(viewNormal, tangent);
  let TBN = mat3x3<f32>(tangent, bitangent, viewNormal);

  // SSAO parameters (hard-coded per LO 5.9 tutorial defaults; tune via
  // SsaoUniform after M3/M4 integration).
  let RADIUS = 0.5;
  let BIAS = 0.025;

  var occlusion = 0.0;
  for (var i = 0u; i < 64u; i = i + 1u) {
    // Tangent-space sample -> view-space via TBN.
    let sampleTangent = ssao_kernel[i];
    var sampleView = TBN * sampleTangent;
    sampleView = viewPos + sampleView * RADIUS;

    // Project sample to screen.
    var offset = ssao_uniform.projection * vec4<f32>(sampleView, 1.0);
    offset = offset / offset.w;
    offset = offset * 0.5 + 0.5;

    // Sample depth at the projected screen location.
    let sampleDepth = textureSampleLevel(hdr_depth, ssao_depth_sampler, offset.xy, 0);
    // Reconstruct view-space z of the sampled fragment (at offset.xy).
    var sampledViewPosH = ssao_uniform.inverseProjection * vec4<f32>(offset.xy * 2.0 - 1.0, sampleDepth, 1.0);
    sampledViewPosH = sampledViewPosH / sampledViewPosH.w;
    let sampledViewZ = sampledViewPosH.z;

    // Range check: smoothstep based on distance along view-z axis.
    let rangeCheck = smoothstep(0.0, 1.0, RADIUS / abs(viewPos.z - sampledViewZ));
    let sampleContrib = select(0.0, 1.0, sampledViewZ >= sampleView.z + BIAS);
    occlusion += sampleContrib * rangeCheck;
  }

  occlusion = 1.0 - (occlusion / 64.0);
  return occlusion;
}

// ── fs_ssao_blur: 4x4 box blur (LO 5.9, OOS-3) ─────────────────────────────

@fragment
fn fs_ssao_blur(in : SsaoVsOut) -> @location(0) f32 {
  // D-D fix: blur reads ssaoRaw (half-res calc output), not gbuffer_normal.
  // Pre-w37 the dimensions + sample texture both incorrectly named
  // gbuffer_normal — copy-paste typo from fs_ssao_calc that produced no
  // occlusion at all (the blur ran a 4x4 average over packed world normals).
  let texelSize = 1.0 / vec2<f32>(textureDimensions(ssaoRaw, 0));
  var result = 0.0;
  for (var x = -2; x < 2; x = x + 1) {
    for (var y = -2; y < 2; y = y + 1) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      result += textureSample(ssaoRaw, ssaoSampler, in.uv + offset).r;
    }
  }
  return result / 16.0;
}