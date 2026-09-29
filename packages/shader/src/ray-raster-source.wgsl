#define_import_path forgeax_ray::raster_source
#import forgeax_view::common::{View, hash32}
#import forgeax_pbr::gbuffer::{decodeStandardNormalRoughness}
#import forgeax_pbr::ray_bsdf::{rayBasis}

@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var normal: texture_2d<u32>;
@group(0) @binding(2) var identity: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> records: array<vec4u>;
@group(0) @binding(4) var<uniform> view: View;
// Seed and sample index belong to the submitted frame, not a CPU readback.
@group(0) @binding(5) var<uniform> sample: vec4u;
@group(0) @binding(6) var<storage, read_write> rays: array<vec4u>;

fn worldPosition(pixel: vec2f, value: f32, extent: vec2u) -> vec3f {
  let uv = pixel / vec2f(extent);
  let p = view.inverseViewProj * vec4f(uv * vec2f(2,-2) + vec2f(-1,1), value, 1);
  return p.xyz / p.w;
}

// PathState.state.w keeps the producer diagnostic: 0 background, 1 active,
// 2 hemisphere null, 3 invalid row/primitive, 4 invalid depth/position,
// 5 invalid coverage flags, 6 mismatched extent. It is not transport validity.
fn reject(base: u32, reason: u32) {
  rays[base + 3u].w = bitcast<u32>(1.0);
  rays[base + 4u].w = reason;
}

@compute @workgroup_size(64) fn generateRasterRays(@builtin(global_invocation_id) id: vec3u) {
  let base = id.x * 5u;
  if (base >= arrayLength(&rays)) { return; }
  for (var lane = 0u; lane < 5u; lane++) { rays[base + lane] = vec4u(0u); }
  let extent = textureDimensions(depth);
  if (arrayLength(&rays) != extent.x * extent.y * 5u ||
      any(textureDimensions(normal) != extent) ||
      any(textureDimensions(identity) != extent)) { reject(base, 6u); return; }
  let pixel = vec2i(i32(id.x % extent.x), i32(id.x / extent.x));
  let surface = textureLoad(identity, pixel, 0);
  let z = textureLoad(depth, pixel, 0);
  if (all(surface == vec4u(0u)) && z == 0.0) { return; }
  if ((surface.w != 1u && surface.w != 3u) || surface.x == 0u) {
    reject(base, 5u); return;
  }
  if (surface.x > arrayLength(&records) / 4u) { reject(base, 3u); return; }
  let row = (surface.x - 1u) * 4u;
  let elements = records[row + 2u].z;
  if (elements == 0u || elements % 3u != 0u || surface.y >= elements / 3u) {
    reject(base, 3u); return;
  }
  if (!(z > 0.0 && z <= 1.0)) { reject(base, 4u); return; }
  let center = vec2f(pixel) + vec2f(0.5);
  let position = worldPosition(center, z, extent);
  if (!all(abs(position) < vec3f(1e30))) { reject(base, 4u); return; }
  let ng = decodeStandardNormalRoughness(surface.z).xyz;
  let ns = decodeStandardNormalRoughness(textureLoad(normal, pixel, 0).x).xyz;
  let rng = hash32(id.x ^ sample.x ^ hash32(sample.y));
  let u = f32(rng >> 8u) * (1.0 / 16777216.0);
  let v = f32(hash32(rng) >> 8u) * (1.0 / 16777216.0);
  let radius = sqrt(u);
  let phi = 6.28318530718 * v;
  // Normalize after backend trigonometry so t remains a world-space distance.
  let direction = normalize(rayBasis(ns) * vec3f(radius * cos(phi), radius * sin(phi), sqrt(1.0-u)));
  let outgoing = view.cameraPos - position;
  // Rejected directions keep their zero-contribution mass; never resample.
  let accepted = dot(direction, ng) > 0.0 && dot(outgoing, ng) > 0.0 && dot(outgoing, ns) > 0.0;
  let bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
  let footprint = max(length(worldPosition(center + vec2f(1,0), z, extent) - position),
                      length(worldPosition(center + vec2f(0,1), z, extent) - position));
  if (!(footprint >= 0.0 && footprint < 1e30)) { reject(base, 4u); return; }
  // Unit diffuse cone spread follows the existing reference approximation.
  // Unit Lambert * cosine / cosine-PDF is one: this produces D = E/pi.
  // Receiver material response belongs to the later composite, after filtering.
  rays[base] = bitcast<vec4u>(vec4f(position + ng * bias, footprint));
  rays[base + 1u] = bitcast<vec4u>(vec4f(direction, 1.0));
  rays[base + 2u] = bitcast<vec4u>(vec4f(1, 1, 1, 0));
  rays[base + 4u] = vec4u(select(0u,1u,accepted), 0u, rng, select(2u,1u,accepted));
}
