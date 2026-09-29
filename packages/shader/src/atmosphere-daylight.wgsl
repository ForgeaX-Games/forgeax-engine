#define_import_path forgeax_environment::daylight

// Bounded analytic Rayleigh/Mie daylight. Spectral coefficients and scale
// heights follow Three.js r184 Sky.js (MIT); no sun disc is baked into IBL.
// https://github.com/mrdoob/three.js/blob/r184/examples/jsm/objects/Sky.js
// The finite horizon column is a game-oriented approximation, not Perez 1999
// or a full spherical multiple-scattering atmosphere. Work occurs only when
// the existing cubemap producer is invalidated, never per background pixel.
const DAYLIGHT_RAYLEIGH: vec3<f32> = vec3<f32>(5.804543e-6, 1.356291e-5, 3.026590e-5);
const DAYLIGHT_MIE: vec3<f32> = vec3<f32>(1.839992e14, 2.779802e14, 4.079048e14);

fn daylight_air_mass(elevation: f32) -> f32 {
  // Bound the effective horizon column to ~4 zenith columns. An infinite
  // plane-parallel column saturates every wavelength and paints a grey wall.
  // The smooth bound keeps cubemap derivatives continuous at the horizon.
  let mu = max(elevation, 0.0);
  return 1.0 / sqrt(mu * mu + 0.0625);
}

fn daylight_sky_radiance(
  viewDirection: vec3<f32>,
  sunDirection: vec3<f32>,
  sunColor: vec3<f32>,
  sunIlluminance: f32,
  turbidity: f32,
  rayleigh: f32,
  mieCoefficient: f32,
  mieDirectionalG: f32,
  circumsolarStrength: f32,
  circumsolarWidth: f32,
) -> vec3<f32> {
  let view = normalize(vec3<f32>(viewDirection.x, max(viewDirection.y, 0.0), viewDirection.z) + vec3<f32>(0.0, 1e-6, 0.0));
  let sun = normalize(sunDirection);
  let betaR = DAYLIGHT_RAYLEIGH * max(rayleigh, 0.0);
  let betaM = DAYLIGHT_MIE * (0.434 * 0.2e-17 * clamp(turbidity, 1.0, 20.0) * max(mieCoefficient, 0.0));
  let opticalDepth = betaR * 8400.0 + betaM * 1250.0;
  let extinction = exp(-opticalDepth * daylight_air_mass(view.y));
  let solarTransmittance = exp(-opticalDepth * daylight_air_mass(sun.y));
  let cosine = clamp(dot(view, sun), -1.0, 1.0);
  let rayleighPhase = 0.75 * (1.0 + cosine * cosine);
  let width = max(circumsolarWidth, 0.25);
  // Keep width=1 identical to the authored Mie anisotropy. Raising the
  // anisotropy base to a larger exponent lowers g and broadens the lobe.
  let widthExponent = max(0.25, 1.0 + (width - 1.0) * 1.25);
  let g = pow(clamp(mieDirectionalG, 0.0, 0.98), widthExponent);
  let mieDenominator = max(1.0 + g * g - 2.0 * g * cosine, 0.001);
  let miePhase = (1.0 - g * g) / pow(mieDenominator, 1.5);
  // The finite 128-face cache undersamples the outer tail of a wide lobe.
  // Add a compact, width-only forward halo so authored expansion survives
  // cache filtering and 8-bit presentation without changing width=1.
  let widthExpansion = max(width - 1.0, 0.0);
  let angularDistance = max(1.0 - cosine, 0.0);
  let haloCenter = 0.012 + 0.012 * widthExpansion;
  let haloSpread = 0.012 + 0.012 * widthExpansion;
  let halo = exp(-pow((angularDistance - haloCenter) / haloSpread, 2.0));
  let widenedMiePhase = miePhase + widthExpansion * halo * 8.0;
  let opticalResponse = solarTransmittance * (vec3<f32>(1.0) - extinction) /
    max(betaR + betaM, vec3<f32>(1e-8));
  // Sky.js's spectral contrast is applied to the Rayleigh sky alone. The Mie
  // lobe remains additive so width and strength preserve their angular meaning.
  // Both responses precede solar energy, keeping that public control linear.
  let rayleighResponse = pow(max(opticalResponse * betaR * rayleighPhase, vec3<f32>(0.0)), vec3<f32>(1.5));
  let mieResponse = opticalResponse * betaM * widenedMiePhase * clamp(circumsolarStrength, 0.0, 4.0);
  let daylight = max(sunColor, vec3<f32>(0.0)) * max(sunIlluminance, 0.0) * (rayleighResponse + mieResponse);
  let night = mix(vec3<f32>(0.008, 0.012, 0.024), vec3<f32>(0.0015, 0.004, 0.016), pow(view.y, 0.35));
  let daylightWeight = smoothstep(-0.12, 0.02, sun.y);
  return clamp(mix(night, daylight, daylightWeight), vec3<f32>(0.0), vec3<f32>(65504.0));
}
