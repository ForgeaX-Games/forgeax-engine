#define_import_path forgeax_pbr::lighting_attenuation

// Shared punctual light optics. Range is represented by the host-derived
// inverse squared range; the shader never reconstructs authoring units.
fn evalDistanceAttenuation(dSquared : f32, invRangeSquared : f32) -> f32 {
  let safeDistance = max(dSquared, 1e-4);
  let window = clamp(1.0 - (safeDistance * invRangeSquared) * (safeDistance * invRangeSquared), 0.0, 1.0);
  return window * window / safeDistance;
}

fn evalSpotAttenuation(
  lightPos : vec3<f32>,
  lightDir : vec3<f32>,
  worldPos : vec3<f32>,
  cosInner : f32,
  cosOuter : f32,
  invRangeSquared : f32,
) -> f32 {
  let toLight = lightPos - worldPos;
  let dSquared = dot(toLight, toLight);
  let distance = evalDistanceAttenuation(dSquared, invRangeSquared);
  let direction = normalize(select(vec3<f32>(0.0, 0.0, -1.0), toLight, dSquared > 1e-4));
  let cone = smoothstep(cosOuter, cosInner, dot(direction, -normalize(lightDir)));
  return distance * cone;
}

// Isolated volume radiance helpers: this module has no resource bindings, so
// compute stages can reuse the exact surface attenuation and cone facts.
fn evalVolumePointRadiance(
  lightPos : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared : f32,
  worldPos : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  return colorTimesIntensity * evalDistanceAttenuation(dSquared, invRangeSquared);
}

fn evalVolumeSpotRadiance(
  lightPos : vec3<f32>,
  lightDir : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner : f32,
  cosOuter : f32,
  invRangeSquared : f32,
  worldPos : vec3<f32>,
) -> vec3<f32> {
  return colorTimesIntensity * evalSpotAttenuation(
    lightPos, lightDir, worldPos, cosInner, cosOuter, invRangeSquared,
  );
}

fn projectSpotUv(lightViewProj : mat4x4<f32>, worldPos : vec3<f32>) -> vec2<f32> {
  let clip = lightViewProj * vec4<f32>(worldPos, 1.0);
  let invW = select(1.0 / clip.w, 0.0, abs(clip.w) < 1e-6);
  return vec2<f32>(clip.x * invW * 0.5 + 0.5, clip.y * invW * -0.5 + 0.5);
}
