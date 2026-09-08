#define_import_path forgeax_environment::background

// @forgeax/engine-shader - atmosphere-background.wgsl
//
// Background composition is deliberately separate from the Preetham cube.
// The sun disc is added exactly once at the background consumer and is never
// part of the sky-cube or IBL producer output.

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::View
#import forgeax_view::common::fullscreen_triangle

struct AtmosphereBackgroundParams {
  sunDirection: vec3<f32>,
  sunIlluminance: f32,
  sunColor: vec3<f32>,
  _sunColorPad: f32,
  turbidity: f32,
  rayleigh: f32,
  mieCoefficient: f32,
  mieDirectionalG: f32,
  sunAngularRadius: f32,
  sunDiscEnabled: f32,
  _tailPad: vec2<f32>,
};

@group(0) @binding(0) var sky: texture_cube<f32>;
@group(0) @binding(1) var skySampler: sampler;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var<uniform> atmosphere: AtmosphereBackgroundParams;

fn atmosphere_sun_disc_radiance(
  viewDirection: vec3<f32>,
  sunDirection: vec3<f32>,
  sunColor: vec3<f32>,
  sunIlluminance: f32,
  angularRadius: f32,
) -> vec3<f32> {
  let alignment = dot(normalize(viewDirection), normalize(sunDirection));
  let edge = smoothstep(
    cos(max(angularRadius * 1.5, 1e-6)),
    cos(max(angularRadius, 1e-6)),
    alignment,
  );
  let solidAngle = 2.0 * 3.14159265359 * (1.0 - cos(max(angularRadius, 1e-6)));
  return max(sunColor, vec3<f32>(0.0)) * max(sunIlluminance, 0.0) * edge / solidAngle;
}

@vertex
fn atmosphere_background_vs(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
  // Keep the fullscreen primitive at the far plane. The render graph binds
  // the existing depth authority read-only, so fixed-function less-equal
  // rejects background fragments covered by geometry without sampling depth.
  var output = fullscreen_triangle(vertexIndex);
  output.position.z = 1.0;
  return output;
}

fn atmosphere_background_direction(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  let world = view.inverseViewProj * ndc;
  return normalize(world.xyz / world.w - view.cameraPos);
}

@fragment
fn atmosphere_background_fs(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let direction = atmosphere_background_direction(input.uv);
  let cubeDirection = vec3<f32>(direction.x, -direction.y, direction.z);
  var radiance = textureSample(sky, skySampler, cubeDirection).rgb;
  if (atmosphere.sunDiscEnabled > 0.5 && atmosphere.sunDirection.y > 0.0) {
    radiance += atmosphere_sun_disc_radiance(
      direction,
      atmosphere.sunDirection,
      atmosphere.sunColor,
      atmosphere.sunIlluminance,
      atmosphere.sunAngularRadius,
    );
  }
  return vec4<f32>(radiance, 1.0);
}
