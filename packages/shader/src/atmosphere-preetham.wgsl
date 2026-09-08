#define_import_path forgeax_environment::preetham

// @forgeax/engine-shader - atmosphere-preetham.wgsl
//
// Build-time Preetham/Perez daylight evaluator. The cubemap producer is the
// only caller. Background composition owns the sun disc separately so this
// module cannot accidentally bake the disc into sky or IBL radiance.

const PREETHAM_ALGORITHM_REVISION : u32 = 1999u;
const PREETHAM_PI : f32 = 3.14159265359;
const PREETHAM_YXY_EPSILON : f32 = 1e-5;
const PREETHAM_RADIANCE_MAX : f32 = 65504.0;

// Each vec2 stores the turbidity slope and intercept for Perez A/B/C/D/E.
// Keeping Y, x and y independent is essential: they are three distributions,
// not one luminance curve followed by invented chromaticity.
const PREETHAM_PEREZ_Y_COEFFICIENTS : array<vec2<f32>, 5> = array<vec2<f32>, 5>(
  vec2<f32>(0.1787, -1.4630),
  vec2<f32>(-0.3554, 0.4275),
  vec2<f32>(-0.0227, 5.3251),
  vec2<f32>(0.1206, -2.5771),
  vec2<f32>(-0.0670, 0.3703),
);

const PREETHAM_PEREZ_X_COEFFICIENTS : array<vec2<f32>, 5> = array<vec2<f32>, 5>(
  vec2<f32>(-0.0193, -0.2592),
  vec2<f32>(-0.0665, 0.0008),
  vec2<f32>(-0.0004, 0.2125),
  vec2<f32>(-0.0641, -0.8989),
  vec2<f32>(-0.0033, 0.0452),
);

const PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS : array<vec2<f32>, 5> = array<vec2<f32>, 5>(
  vec2<f32>(-0.0167, -0.2608),
  vec2<f32>(-0.0950, 0.0092),
  vec2<f32>(-0.0079, 0.2102),
  vec2<f32>(-0.0441, -1.6537),
  vec2<f32>(-0.0109, 0.0529),
);

struct PreethamPerezCoefficients {
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
};

fn preetham_finite_guard(value: vec3<f32>) -> vec3<f32> {
  // Inputs are validated before the producer reaches this module. Clamp the
  // output to the finite half-float domain as a second shader-side guard.
  return clamp(value, vec3<f32>(0.0), vec3<f32>(PREETHAM_RADIANCE_MAX));
}

fn preetham_yxy_to_linear_srgb(yxy: vec3<f32>) -> vec3<f32> {
  let Y = max(yxy.x, 0.0);
  let x = clamp(yxy.y, 0.0, 1.0);
  let y = clamp(yxy.z, PREETHAM_YXY_EPSILON, 1.0);
  let X = Y * x / y;
  let Z = Y * max(1.0 - x - y, 0.0) / y;
  let linear = vec3<f32>(
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  );
  return preetham_finite_guard(max(linear, vec3<f32>(0.0)));
}

fn preetham_fit(fit: vec2<f32>, turbidity: f32) -> f32 {
  return fit.x * turbidity + fit.y;
}

fn preetham_y_coefficients(turbidity: f32) -> PreethamPerezCoefficients {
  return PreethamPerezCoefficients(
    preetham_fit(PREETHAM_PEREZ_Y_COEFFICIENTS[0], turbidity),
    preetham_fit(PREETHAM_PEREZ_Y_COEFFICIENTS[1], turbidity),
    preetham_fit(PREETHAM_PEREZ_Y_COEFFICIENTS[2], turbidity),
    preetham_fit(PREETHAM_PEREZ_Y_COEFFICIENTS[3], turbidity),
    preetham_fit(PREETHAM_PEREZ_Y_COEFFICIENTS[4], turbidity),
  );
}

fn preetham_x_coefficients(turbidity: f32) -> PreethamPerezCoefficients {
  return PreethamPerezCoefficients(
    preetham_fit(PREETHAM_PEREZ_X_COEFFICIENTS[0], turbidity),
    preetham_fit(PREETHAM_PEREZ_X_COEFFICIENTS[1], turbidity),
    preetham_fit(PREETHAM_PEREZ_X_COEFFICIENTS[2], turbidity),
    preetham_fit(PREETHAM_PEREZ_X_COEFFICIENTS[3], turbidity),
    preetham_fit(PREETHAM_PEREZ_X_COEFFICIENTS[4], turbidity),
  );
}

fn preetham_small_y_coefficients(turbidity: f32) -> PreethamPerezCoefficients {
  return PreethamPerezCoefficients(
    preetham_fit(PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS[0], turbidity),
    preetham_fit(PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS[1], turbidity),
    preetham_fit(PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS[2], turbidity),
    preetham_fit(PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS[3], turbidity),
    preetham_fit(PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS[4], turbidity),
  );
}

fn preetham_perez(
  theta: f32,
  gamma: f32,
  coefficients: PreethamPerezCoefficients,
) -> f32 {
  let safeCosTheta = max(cos(theta), 0.01);
  let cosGamma = cos(max(gamma, 0.0));
  let horizon = 1.0 + coefficients.a * exp(coefficients.b / safeCosTheta);
  let circumsolar = 1.0 + coefficients.c * exp(coefficients.d * max(gamma, 0.0)) +
    coefficients.e * cosGamma * cosGamma;
  return max(horizon * circumsolar, PREETHAM_YXY_EPSILON);
}

fn preetham_relative_perez(
  theta: f32,
  gamma: f32,
  sunTheta: f32,
  coefficients: PreethamPerezCoefficients,
) -> f32 {
  let numerator = preetham_perez(theta, gamma, coefficients);
  let zenith = preetham_perez(0.0, sunTheta, coefficients);
  return numerator / max(zenith, PREETHAM_YXY_EPSILON);
}

fn preetham_zenith_yxy(sunTheta: f32, turbidity: f32) -> vec3<f32> {
  let theta2 = sunTheta * sunTheta;
  let theta3 = theta2 * sunTheta;
  let turbidity2 = turbidity * turbidity;
  let chi = (4.0 / 9.0 - turbidity / 120.0) * (PREETHAM_PI - 2.0 * sunTheta);
  let Y = (4.0453 * turbidity - 4.9710) * tan(chi) -
    0.2155 * turbidity + 2.4192;
  let x =
    (0.00165 * theta3 - 0.00374 * theta2 + 0.00208 * sunTheta) * turbidity2 +
    (-0.02902 * theta3 + 0.06377 * theta2 - 0.03202 * sunTheta + 0.00394) * turbidity +
    (0.11693 * theta3 - 0.21196 * theta2 + 0.06052 * sunTheta + 0.25885);
  let y =
    (0.00275 * theta3 - 0.00610 * theta2 + 0.00316 * sunTheta) * turbidity2 +
    (-0.04214 * theta3 + 0.08970 * theta2 - 0.04153 * sunTheta + 0.00515) * turbidity +
    (0.15346 * theta3 - 0.26756 * theta2 + 0.06669 * sunTheta + 0.26688);
  return vec3<f32>(max(Y, 0.0), clamp(x, 0.0, 1.0), clamp(y, PREETHAM_YXY_EPSILON, 1.0));
}

// Evaluate one HDR sky direction. Preetham Y is kcd/m2, so the 0.01 factor
// maps it to renderer radiance per a 100,000-lux daylight reference. The
// authoring Rayleigh/Mie controls remain bounded relative gains around the
// complete Perez Y/x/y distribution instead of replacing its chromaticity.
fn preetham_sky_radiance(
  viewDirection: vec3<f32>,
  sunDirection: vec3<f32>,
  sunColor: vec3<f32>,
  sunIlluminance: f32,
  turbidity: f32,
  rayleigh: f32,
  mieCoefficient: f32,
  mieDirectionalG: f32,
) -> vec3<f32> {
  let horizonClampedView = vec3<f32>(
    viewDirection.x,
    max(viewDirection.y, 0.0),
    viewDirection.z,
  );
  let view = horizonClampedView /
    max(length(horizonClampedView), PREETHAM_YXY_EPSILON);
  let sun = sunDirection / max(length(sunDirection), PREETHAM_YXY_EPSILON);
  let theta = acos(clamp(view.y, 0.0, 1.0));
  let sunTheta = acos(clamp(sun.y, 0.0, 1.0));
  let sunAlignment = clamp(dot(view, sun), -1.0, 1.0);
  let gamma = acos(sunAlignment);
  let safeTurbidity = clamp(turbidity, 1.0, 20.0);
  let zenithYxy = preetham_zenith_yxy(sunTheta, safeTurbidity);
  let relativeY = preetham_relative_perez(
    theta,
    gamma,
    sunTheta,
    preetham_y_coefficients(safeTurbidity),
  );
  let relativeX = preetham_relative_perez(
    theta,
    gamma,
    sunTheta,
    preetham_x_coefficients(safeTurbidity),
  );
  let relativeSmallY = preetham_relative_perez(
    theta,
    gamma,
    sunTheta,
    preetham_small_y_coefficients(safeTurbidity),
  );
  let forward = pow(max(sunAlignment, 0.0), mix(2.0, 32.0, clamp(mieDirectionalG, 0.0, 0.999)));
  let mediumGain = max(rayleigh, 0.0) + max(mieCoefficient, 0.0) * 40.0 * (0.25 + forward);
  let luminance = zenithYxy.x * relativeY * max(sunIlluminance, 0.0) * 0.01 * mediumGain;
  let yxy = vec3<f32>(
    max(luminance, 0.0),
    clamp(zenithYxy.y * relativeX, 0.0, 1.0),
    clamp(zenithYxy.z * relativeSmallY, PREETHAM_YXY_EPSILON, 1.0),
  );
  let tintStrength = 0.08 + 0.32 * pow(max(sunAlignment, 0.0), 4.0);
  let skyTint = mix(
    vec3<f32>(1.0),
    max(sunColor, vec3<f32>(0.0)),
    tintStrength,
  );
  let daylight = preetham_yxy_to_linear_srgb(yxy) * skyTint;
  // Preetham is a daylight model. Below the civil-twilight boundary, blend to
  // a bounded blue night gradient instead of extrapolating Perez into the
  // characteristic green/purple failure that the model cannot represent.
  let daylightWeight = smoothstep(-0.12, 0.02, sun.y);
  let nightHorizon = vec3<f32>(0.008, 0.012, 0.024);
  let nightZenith = vec3<f32>(0.0015, 0.004, 0.016);
  let night = mix(nightHorizon, nightZenith, pow(clamp(view.y, 0.0, 1.0), 0.35));
  return preetham_finite_guard(mix(night, daylight, daylightWeight));
}
