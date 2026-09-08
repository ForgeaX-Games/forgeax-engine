#define_import_path forgeax_view::fog

// Shared analytic scene-radiance Fog. Producers provide a world-space ray;
// this module owns the density integration and linear color contract.
#import forgeax_view::common::{FogViewParams, FogRay}

const FOG_Q_EPSILON : f32 = 1e-6;
const FOG_EXP_LIMIT : f32 = 80.0;

fn fogOpticalDepth(params : FogViewParams, ray : FogRay) -> f32 {
  let rho0 = params.density * exp(clamp(-params.heightFalloff * ray.origin.y, -FOG_EXP_LIMIT, FOG_EXP_LIMIT));
  let q = params.heightFalloff * ray.direction.y;
  var tau = rho0 * ray.distance;
  if abs(q) >= FOG_Q_EPSILON {
    let exponent = clamp(-q * ray.distance, -FOG_EXP_LIMIT, FOG_EXP_LIMIT);
    tau = rho0 * (1.0 - exp(exponent)) / q;
  }
  return max(tau, 0.0);
}

fn apply_fog(params : FogViewParams, ray : FogRay, color : vec4<f32>) -> vec4<f32> {
  let tau = fogOpticalDepth(params, ray);
  let transmittance = exp(-tau);
  let opacity = params.maxOpacity * (1.0 - transmittance);
  let mixed = mix(color.rgb, params.color, opacity);
  return vec4<f32>(mixed, color.a);
}
