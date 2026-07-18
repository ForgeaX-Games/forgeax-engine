#define_import_path forgeax_view::fxaa

// @forgeax/engine-shader - fxaa.wgsl
// (feat-20260528-fxaa-post-processing / w4; algorithm rewritten
//  feat-20260531-fxaa-shader-correctness-fix).
//
// FXAA 3.11 fragment shader -- faithful port of the canonical Simon
// Rodriguez reference (same lineage as Bevy's WGSL port), adapted to
// forgeax naga_oil conventions. Hardcoded "High" quality preset: 12-step
// edge search with compile-time step multipliers (no UBO, no #ifdef quality
// branches).
//
// Vertex stage: imports the SSOT fullscreen_triangle() from
// forgeax_view::common (single large triangle, research Finding 1).
//
// Fragment stage: computes perceptual luma via rgb2luma (sqrt of Rec.601
// weighted sum -- matches the canonical reference), performs a directional
// edge search, then blends along the edge with a sub-pixel aliasing term.
// Texture dimensions are obtained via textureDimensions() for resize-agnostic
// behavior (AC-08).
//
// SAMPLING: uses textureSampleLevel (explicit LOD 0) with a linear sampler,
// NOT textureLoad. Explicit-LOD sampling is permitted in non-uniform control
// flow (WebGPU spec 20.1 only bars *implicit*-derivative textureSample), so
// the edge-search loops are legal while still getting bilinear filtering --
// the bilinear taps at fractional UVs are what actually do the sub-texel
// blend that anti-aliases the edge.
//
// All offsets are kept in UV space: texel steps are scaled by
// inverseScreenSize (= 1/dims) before being added to a [0,1] UV. The prior
// implementation added texel-unit offsets directly to UVs (and squared
// texelSize in the sub-pixel term), sampling ~half a screen away and gouging
// holes in shaded surfaces -- the bug this rewrite fixes.
//
// Bindings (group 0):
//   @binding(0) screenTexture : texture_2d<f32>  -- sampled LDR input
//   @binding(1) samp          : sampler           -- linear filterable sampler

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle

const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const EDGE_THRESHOLD_MAX: f32 = 0.125;
const SUBPIXEL_QUALITY: f32 = 0.75;
const ITERATIONS: i32 = 12;

@group(0) @binding(0) var screenTexture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

fn rgb2luma(rgb: vec3<f32>) -> f32 {
  return sqrt(dot(rgb, vec3<f32>(0.299, 0.587, 0.114)));
}

fn sampleColor(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(screenTexture, samp, uv, 0.0).rgb;
}

fn sampleLuma(uv: vec2<f32>) -> f32 {
  return rgb2luma(textureSampleLevel(screenTexture, samp, uv, 0.0).rgb);
}

// High-preset edge-search step multipliers (canonical FXAA 3.11 QUALITY
// table for the 12-tap variant): steps 0..4 = 1.0, then ramps to 8.0.
fn qualityStep(i: i32) -> f32 {
  if i < 5 {
    return 1.0;
  }
  if i == 5 {
    return 1.5;
  }
  if i < 10 {
    return 2.0;
  }
  if i == 10 {
    return 4.0;
  }
  return 8.0;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in: FullscreenOutput) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(screenTexture));
  let inverseScreenSize = 1.0 / dims;
  let uv = in.uv;

  let centerColor = sampleColor(uv);
  let lumaCenter = rgb2luma(centerColor);

  // Lumas of the 4 direct neighbours.
  let lumaDown = sampleLuma(uv + vec2<f32>(0.0, 1.0) * inverseScreenSize);
  let lumaUp = sampleLuma(uv + vec2<f32>(0.0, -1.0) * inverseScreenSize);
  let lumaLeft = sampleLuma(uv + vec2<f32>(-1.0, 0.0) * inverseScreenSize);
  let lumaRight = sampleLuma(uv + vec2<f32>(1.0, 0.0) * inverseScreenSize);

  let lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
  let lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));
  let lumaRange = lumaMax - lumaMin;

  // Not on an edge (or in a near-uniform region): pass the centre through.
  if lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX) {
    return vec4<f32>(centerColor, 1.0);
  }

  // Lumas of the 4 corners.
  let lumaDownLeft = sampleLuma(uv + vec2<f32>(-1.0, 1.0) * inverseScreenSize);
  let lumaUpRight = sampleLuma(uv + vec2<f32>(1.0, -1.0) * inverseScreenSize);
  let lumaUpLeft = sampleLuma(uv + vec2<f32>(-1.0, -1.0) * inverseScreenSize);
  let lumaDownRight = sampleLuma(uv + vec2<f32>(1.0, 1.0) * inverseScreenSize);

  let lumaDownUp = lumaDown + lumaUp;
  let lumaLeftRight = lumaLeft + lumaRight;

  let lumaLeftCorners = lumaDownLeft + lumaUpLeft;
  let lumaDownCorners = lumaDownLeft + lumaDownRight;
  let lumaRightCorners = lumaDownRight + lumaUpRight;
  let lumaUpCorners = lumaUpRight + lumaUpLeft;

  // Estimate horizontal vs vertical gradient.
  let edgeHorizontal =
    abs(-2.0 * lumaLeft + lumaLeftCorners) +
    abs(-2.0 * lumaCenter + lumaDownUp) * 2.0 +
    abs(-2.0 * lumaRight + lumaRightCorners);
  let edgeVertical =
    abs(-2.0 * lumaUp + lumaUpCorners) +
    abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0 +
    abs(-2.0 * lumaDown + lumaDownCorners);

  let isHorizontal = edgeHorizontal >= edgeVertical;

  // Lumas on the two sides of the edge.
  let luma1 = select(lumaLeft, lumaDown, isHorizontal);
  let luma2 = select(lumaRight, lumaUp, isHorizontal);
  let gradient1 = luma1 - lumaCenter;
  let gradient2 = luma2 - lumaCenter;

  let is1Steepest = abs(gradient1) >= abs(gradient2);
  let gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

  // One-texel step perpendicular to the edge, in UV space.
  var stepLength = select(inverseScreenSize.x, inverseScreenSize.y, isHorizontal);

  var lumaLocalAverage = 0.0;
  if is1Steepest {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
  } else {
    lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
  }

  // Shift the UV by half a texel toward the edge.
  var currentUv = uv;
  if isHorizontal {
    currentUv.y += stepLength * 0.5;
  } else {
    currentUv.x += stepLength * 0.5;
  }

  // Walk along the edge in both directions until the luma delta exceeds the
  // local gradient (= we left the edge) or we run out of iterations.
  let offsetStep = select(
    vec2<f32>(stepLength, 0.0),
    vec2<f32>(0.0, stepLength),
    isHorizontal,
  );
  let edgeStep = select(
    vec2<f32>(0.0, inverseScreenSize.y),
    vec2<f32>(inverseScreenSize.x, 0.0),
    isHorizontal,
  );

  var uv1 = currentUv - edgeStep;
  var uv2 = currentUv + edgeStep;

  var lumaEnd1 = sampleLuma(uv1) - lumaLocalAverage;
  var lumaEnd2 = sampleLuma(uv2) - lumaLocalAverage;

  var reached1 = abs(lumaEnd1) >= gradientScaled;
  var reached2 = abs(lumaEnd2) >= gradientScaled;
  var reachedBoth = reached1 && reached2;

  if !reached1 {
    uv1 -= edgeStep;
  }
  if !reached2 {
    uv2 += edgeStep;
  }

  if !reachedBoth {
    var i = 1;
    loop {
      if i >= ITERATIONS || reachedBoth {
        break;
      }
      let q = qualityStep(i);
      if !reached1 {
        lumaEnd1 = sampleLuma(uv1) - lumaLocalAverage;
        reached1 = abs(lumaEnd1) >= gradientScaled;
      }
      if !reached2 {
        lumaEnd2 = sampleLuma(uv2) - lumaLocalAverage;
        reached2 = abs(lumaEnd2) >= gradientScaled;
      }
      reachedBoth = reached1 && reached2;
      if !reached1 {
        uv1 -= edgeStep * q;
      }
      if !reached2 {
        uv2 += edgeStep * q;
      }
      i += 1;
    }
  }

  // Distances to each end of the edge, along the edge axis.
  let distance1 = select(uv.y - uv1.y, uv.x - uv1.x, isHorizontal);
  let distance2 = select(uv2.y - uv.y, uv2.x - uv.x, isHorizontal);

  let isDirection1 = distance1 < distance2;
  let distanceFinal = min(distance1, distance2);
  let edgeThickness = distance1 + distance2;
  let pixelOffsetRaw = -distanceFinal / edgeThickness + 0.5;

  // Only blend if the centre luma is on the correct side of the edge --
  // guards against haloing.
  let isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  let correctVariation1 = (lumaEnd1 < 0.0) != isLumaCenterSmaller;
  let correctVariation2 = (lumaEnd2 < 0.0) != isLumaCenterSmaller;
  let correctVariation = select(correctVariation2, correctVariation1, isDirection1);
  let finalOffset = select(0.0, pixelOffsetRaw, correctVariation);

  // Sub-pixel anti-aliasing: weight by the local 3x3 luma contrast.
  let lumaAverage =
    (1.0 / 12.0) *
    (2.0 * (lumaDownUp + lumaLeftRight) + lumaLeftCorners + lumaRightCorners);
  let subPixelOffset1 = clamp(abs(lumaAverage - lumaCenter) / lumaRange, 0.0, 1.0);
  let subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
  let subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * SUBPIXEL_QUALITY;

  let pixelOffset = max(finalOffset, subPixelOffsetFinal);

  // Apply the perpendicular offset, in UV space.
  var finalUv = uv;
  if isHorizontal {
    finalUv.y += pixelOffset * stepLength;
  } else {
    finalUv.x += pixelOffset * stepLength;
  }

  let finalColor = sampleColor(finalUv);
  return vec4<f32>(finalColor, 1.0);
}
