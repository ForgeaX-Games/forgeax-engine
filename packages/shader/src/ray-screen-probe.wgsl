#define_import_path forgeax_ray::screen_probe
#import forgeax_view::common::{View}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}
#import forgeax_depth_pyramid::sample::{depthPyramidCell, depthPyramidDepthOrEmpty, depthPyramidLevelSize}
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCache}

// Screen Probe gather (UE LumenScreenProbeGather). Probes are placed on the
// G-buffer, trace an 8x8 world-space octahedron through the previous frame's
// scene color (HZB) and then the Global SDF/Card world (render owner kernel),
// and are integrated per pixel with the Irradiance Field as world fallback.

// Must match packScreenProbeFrame() in render/raytracing/screen-probe-plan.ts.
struct ScreenProbeFrame {
  // width, height, tilesX, tilesY
  extent: vec4u,
  // uniform probes, adaptive capacity, downsample, frame index
  probes: vec4u,
  // brdf importance, screen steps, history flags (1 scene, 2 pixel), max frames
  control: vec4u,
  // rgb environment radiance, w max trace distance
  environment: vec4f,
  // thickness, short-range AO radius, world origin bias, Card margin
  tuning: vec4f,
  // Global SDF query settings consumed by the world kernel
  query: vec4u,
  // Last accepted view geometry, kept across lighting-only temporal resets;
  // all zero (w included) after a geometric reset, which rejects every pixel.
  previousViewProj: mat4x4f,
  previousCameraPos: vec4f,
}
// pixel == SCREEN_PROBE_NONE marks an empty probe slot.
struct ScreenProbe { position: vec3f, distance: f32, normal: vec3f, pixel: u32 }
// info: texel (6) | sub (2) << 6 | refined << 8 | used << 9 | status << 12
struct ProbeRay { direction: vec3f, info: u32, radiance: vec3f, tStart: f32 }

const SCREEN_PROBE_NONE = 0xffffffffu;
const STATUS_RESOLVED = 0u;
const STATUS_WORLD = 1u;
const STATUS_FALLBACK = 2u;
const STATUS_CULLED = 3u;
const STATUS_INCOMPLETE = 4u;
// Scratch support: -1 missing scene, 0 missing radiance, 1 complete transport.
// Missing scene propagates to the pixel; it cannot request another cache fallback.
const SUPPORT_INCOMPLETE = -1.0;
const RAY_USED = 512u;
const RAY_REFINED = 256u;
// BRDF texels below this cosine pdf are culled and their rays refine the top texels.
const CULL_PDF = 0.1;

// Unique group-0 bindings; each pipeline layout names only its entry's roster.
@group(0) @binding(0) var<uniform> probeFrame: ScreenProbeFrame;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var gbufferDepth: texture_depth_2d;
@group(0) @binding(3) var gbufferNormal: texture_2d<u32>;
@group(0) @binding(4) var depthPyramid: texture_2d<f32>;
@group(0) @binding(5) var sceneColor: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> probes: array<ScreenProbe>;
@group(0) @binding(7) var<storage, read> probesIn: array<ScreenProbe>;
@group(0) @binding(8) var<storage, read_write> adaptiveCount: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read> adaptiveCountIn: array<u32>;
@group(0) @binding(10) var<storage, read_write> tileAdaptive: array<u32>;
@group(0) @binding(11) var<storage, read> tileAdaptiveIn: array<u32>;
@group(0) @binding(12) var<storage, read_write> rays: array<ProbeRay>;
@group(0) @binding(13) var<storage, read> raysIn: array<ProbeRay>;
@group(0) @binding(14) var<storage, read> previousScene: array<vec2u>;
@group(0) @binding(15) var<storage, read_write> previousSceneOut: array<vec2u>;
@group(0) @binding(16) var<storage, read> radianceIn: array<vec4f>;
// w is directional support, including an admitted retained cache estimate.
// Ray status still distinguishes actual resolved rays from cache reconstruction.
@group(0) @binding(17) var<storage, read_write> radianceOut: array<vec4f>;
@group(0) @binding(18) var<storage, read_write> probeIrradianceOut: array<vec4f>;
@group(0) @binding(19) var<storage, read> probeIrradiance: array<vec4f>;
@group(0) @binding(20) var<storage, read_write> integratedOut: array<vec4f>;
@group(0) @binding(21) var<storage, read> integrated: array<vec4f>;
@group(0) @binding(22) var<storage, read> historyIn: array<vec4f>;
@group(0) @binding(23) var<storage, read_write> historyOut: array<vec4f>;
@group(0) @binding(24) var<storage, read> metaIn: array<vec4u>;
@group(0) @binding(25) var<storage, read_write> metaOut: array<vec4u>;

fn spLinearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }
fn spGroupId(wid: vec3u, groups: vec3u) -> u32 { return wid.x + wid.y * groups.x; }

fn spHash(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}
fn spUnit(x: u32) -> f32 { return f32(spHash(x) >> 8u) / 16777216.0; }

fn spOctEncode(direction: vec3f) -> vec2f {
  let n = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (n.z >= 0.0) { return n.xy; }
  return (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
}
fn spOctDecode(p: vec2f) -> vec3f {
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}
// Center direction of an 8x8 world-space octahedral texel.
fn texelDirection(texel: u32) -> vec3f {
  let xy = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 8.0;
  return spOctDecode(xy * 2.0 - vec2f(1.0));
}

fn extentSize() -> vec2u { return probeFrame.extent.xy; }
fn pixelIndex(pixel: vec2u) -> u32 { return pixel.y * probeFrame.extent.x + pixel.x; }
fn packPixel(pixel: vec2u) -> u32 { return pixel.x | (pixel.y << 16u); }
fn unpackPixel(packed: u32) -> vec2u { return vec2u(packed & 0xffffu, packed >> 16u); }
fn validDepth(z: f32) -> bool { return z > 0.0 && z < 1.0; }
fn gbufferMatches() -> bool { return all(textureDimensions(gbufferDepth) == extentSize()); }

fn worldPosition(pixel: vec2u, z: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(extentSize());
  let p = view.inverseViewProj * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z, 1.0);
  return p.xyz / p.w;
}

fn emptyProbe() -> ScreenProbe { return ScreenProbe(vec3f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), SCREEN_PROBE_NONE); }

fn probeAt(pixel: vec2u) -> ScreenProbe {
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return emptyProbe(); }
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  return ScreenProbe(position, length(view.cameraPos - position), normal, packPixel(pixel));
}

fn tileCount() -> vec2u { return probeFrame.extent.zw; }

// Plane and normal agreement between a probe and a receiver (UE
// ScreenProbeInterpolation depth/normal weights). Relative to view distance.
fn probeAgreement(probe: ScreenProbe, position: vec3f, normal: vec3f, distance: f32) -> f32 {
  if (probe.pixel == SCREEN_PROBE_NONE) { return 0.0; }
  let plane = abs(dot(probe.position - position, normal)) / max(0.03 * distance, 1e-4);
  let facing = max(dot(probe.normal, normal), 0.0);
  return exp(-plane * plane) * facing * facing * facing * facing;
}

struct UniformTaps { probes: vec4u, weights: vec4f }

// Bilinear uniform probes around a pixel; empty taps carry zero weight.
fn uniformTaps(pixel: vec2u, position: vec3f, normal: vec3f, distance: f32,
    source: ptr<function, array<ScreenProbe, 4>>) -> UniformTaps {
  let tiles = tileCount();
  let ds = f32(probeFrame.probes.z);
  let g = clamp((vec2f(pixel) + vec2f(0.5)) / ds - vec2f(0.5), vec2f(0.0), vec2f(tiles - vec2u(1u)));
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  let f = g - vec2f(base);
  var out = UniformTaps(vec4u(SCREEN_PROBE_NONE), vec4f(0.0));
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let tile = min(base + offset, tiles - vec2u(1u));
    let index = tile.y * tiles.x + tile.x;
    let axis = select(vec2f(1.0) - f, f, offset > vec2u(0u));
    out.probes[tap] = index;
    out.weights[tap] = axis.x * axis.y * probeAgreement((*source)[tap], position, normal, distance);
  }
  return out;
}

// One thread per uniform tile; it also empties the matching adaptive slot so
// stale adaptive probes from the previous frame never reach later stages.
@compute @workgroup_size(64) fn placeUniformProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let uniformCount = probeFrame.probes.x;
  if (i == 0u) { atomicStore(&adaptiveCount[0], 0u); }
  if (i >= uniformCount) { return; }
  if (i < probeFrame.probes.y) { probes[uniformCount + i] = emptyProbe(); }
  for (var s = 0u; s < 4u; s++) { tileAdaptive[i * 4u + s] = SCREEN_PROBE_NONE; }
  probes[i] = emptyProbe();
  if (!gbufferMatches()) { return; }
  let tiles = tileCount();
  let ds = probeFrame.probes.z;
  let tile = vec2u(i % tiles.x, i / tiles.x);
  let extent = extentSize();
  // Per-frame jittered placement converges under temporal accumulation.
  let seed = spHash(i * 9781u + probeFrame.probes.w * 6271u);
  let jitter = vec2u(seed % ds, (seed >> 16u) % ds);
  let candidates = array<vec2u, 2>(tile * ds + jitter, tile * ds + vec2u(ds / 2u));
  for (var c = 0u; c < 2u; c++) {
    let pixel = min(candidates[c], extent - vec2u(1u));
    let probe = probeAt(pixel);
    if (probe.pixel != SCREEN_PROBE_NONE) { probes[i] = probe; return; }
  }
}

// One thread per half-tile. Where the uniform probes interpolate poorly
// (depth/normal discontinuities), allocate an adaptive probe at the half-tile.
@compute @workgroup_size(64) fn placeAdaptiveProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let tiles = tileCount();
  let subTiles = tiles * 2u;
  if (i >= subTiles.x * subTiles.y || probeFrame.probes.y == 0u || !gbufferMatches()) { return; }
  let sub = vec2u(i % subTiles.x, i / subTiles.x);
  let ds = probeFrame.probes.z;
  let pixel = min(sub * (ds / 2u) + vec2u(ds / 4u), extentSize() - vec2u(1u));
  let candidate = probeAt(pixel);
  if (candidate.pixel == SCREEN_PROBE_NONE) { return; }
  var source: array<ScreenProbe, 4>;
  let g = clamp((vec2f(pixel) + vec2f(0.5)) / f32(ds) - vec2f(0.5), vec2f(0.0), vec2f(tiles - vec2u(1u)));
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probes[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, candidate.position, candidate.normal, candidate.distance, &source);
  if (dot(taps.weights, vec4f(1.0)) >= 0.25) { return; }
  let slot = atomicAdd(&adaptiveCount[0], 1u);
  if (slot >= probeFrame.probes.y) { return; }
  let probe = probeFrame.probes.x + slot;
  probes[probe] = candidate;
  let tile = sub / 2u;
  let quadrant = (sub.x & 1u) | ((sub.y & 1u) << 1u);
  tileAdaptive[(tile.y * tiles.x + tile.x) * 4u + quadrant] = probe;
}

fn probeLive(probe: u32) -> bool {
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return false; }
  if (probe >= probeFrame.probes.x && probe - probeFrame.probes.x >= adaptiveCountIn[0]) { return false; }
  return probesIn[probe].pixel != SCREEN_PROBE_NONE;
}

var<workgroup> texelPdf: array<f32, 64>;
var<workgroup> texelSlots: array<u32, 64>;

// One workgroup per probe. BRDF importance (UE ScreenProbeImportanceSampling):
// texels whose cosine pdf around the probe normal is below CULL_PDF are culled,
// and their ray budget refines the highest-pdf texels into 2x2 sub-rays.
@compute @workgroup_size(64) fn generateProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let live = probeLive(probe);
  let record = probesIn[probe];
  let brdf = probeFrame.control.x != 0u;
  let pdf = select(1.0, max(dot(record.normal, texelDirection(texel)), 0.0), brdf);
  texelPdf[texel] = select(-1.0, pdf, !brdf || pdf >= CULL_PDF);
  workgroupBarrier();
  var culled = 0u;
  var rank = 0u;
  for (var t = 0u; t < 64u; t++) {
    let other = texelPdf[t];
    if (other < 0.0) { culled++; continue; }
    if (other > texelPdf[texel] || (other == texelPdf[texel] && t < texel)) { rank++; }
  }
  let mine = texelPdf[texel];
  let refined = mine >= 0.0 && rank < culled / 3u;
  texelSlots[texel] = select(select(1u, 4u, refined), 0u, mine < 0.0);
  workgroupBarrier();
  var first = 0u;
  for (var t = 0u; t < texel; t++) { first += texelSlots[t]; }
  var used = 0u;
  for (var t = 0u; t < 64u; t++) { used += texelSlots[t]; }
  let base = probe * 64u;
  // Adaptive storage slots vary with atomic allocation; sample the receiver identity.
  let seed = spHash(record.pixel * 7919u + probeFrame.probes.w * 104729u);
  let jitter = vec2f(spUnit(seed), spUnit(seed ^ 0x9e3779b9u));
  let count = texelSlots[texel];
  for (var s = 0u; s < count; s++) {
    var xy = vec2f(f32(texel % 8u), f32(texel / 8u));
    var size = 8.0;
    if (refined) { xy = xy * 2.0 + vec2f(f32(s & 1u), f32(s >> 1u)); size = 16.0; }
    let direction = spOctDecode((xy + jitter) / size * 2.0 - vec2f(1.0));
    let status = select(STATUS_CULLED, STATUS_WORLD, live);
    let info = texel | (s << 6u) | select(0u, RAY_REFINED, refined) | RAY_USED | (status << 12u);
    rays[base + first + s] = ProbeRay(direction, info, vec3f(0.0), 0.0);
  }
  // Unassigned tail slots (at most two) stay inert.
  if (texel >= used) { rays[base + texel] = ProbeRay(vec3f(0.0, 0.0, 1.0), STATUS_CULLED << 12u, vec3f(0.0), 0.0); }
}

fn rayStatus(info: u32) -> u32 { return (info >> 12u) & 7u; }
fn withStatus(info: u32, status: u32) -> u32 { return (info & ~(7u << 12u)) | (status << 12u); }

fn traceViewDistance(clip: vec4f) -> f32 {
  return select(clip.w,
    view.temporalProjection.y - (clip.z / clip.w) * (view.temporalProjection.y - view.temporalProjection.x),
    view.temporalProjection.z > 0.5);
}

fn previousRadiance(position: vec3f) -> vec4f {
  let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return vec4f(0.0); }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec4f(0.0); }
  let pixel = min(vec2u(uv * vec2f(extentSize())), extentSize() - vec2u(1u));
  let packed = previousScene[pixelIndex(pixel)];
  let rg = unpack2x16float(packed.x);
  let ba = unpack2x16float(packed.y);
  return vec4f(rg, ba.x, ba.y);
}

// One thread per ray: closest-depth HZB march through the previous frame's
// scene color (UE ScreenProbeTraceScreenTexture). Misses and unresolved rays
// keep status WORLD with tStart at the last proven-free distance.
@compute @workgroup_size(64) fn traceScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  if (i >= (probeFrame.probes.x + probeFrame.probes.y) * 64u) { return; }
  var ray = rays[i];
  if (rayStatus(ray.info) != STATUS_WORLD) { return; }
  let steps = probeFrame.control.y;
  if (steps == 0u || (probeFrame.control.z & 1u) == 0u || !gbufferMatches()) { return; }
  let probe = probesIn[i / 64u];
  let extent = vec2f(extentSize());
  let origin = probe.position + probe.normal * probeFrame.tuning.z;
  let d = ray.direction;
  var tMax = probeFrame.environment.w;
  let c0 = view.worldViewProj * vec4f(origin, 1.0);
  let dc = view.worldViewProj * vec4f(d, 0.0);
  // Keep the segment in front of the near plane.
  let near = view.temporalProjection.x;
  if (view.temporalProjection.z < 0.5 && dc.w < 0.0) {
    tMax = min(tMax, max((c0.w - 1.5 * near) / -dc.w, 0.0));
  }
  if (!(c0.w > 0.0) || tMax <= 0.0) { return; }
  let c1 = c0 + dc * tMax;
  let uv0 = c0.xy / c0.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let uv1 = c1.xy / c1.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let delta = uv1 - uv0;
  let pixels = length(delta * extent);
  if (pixels < 1.0) { return; }
  let w0 = traceViewDistance(c0);
  let w1 = traceViewDistance(c1);
  let perspective = view.temporalProjection.z < 0.5;
  let thickness = probeFrame.tuning.x;
  let maxLevel = textureNumLevels(depthPyramid) - 1u;
  var u = 1.0 / pixels;
  var level = 0u;
  var freeT = 0.0;
  for (var step = 0u; step < steps; step++) {
    if (u >= 1.0) { break; }
    let uv = uv0 + delta * u;
    if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { break; }
    let size = depthPyramidLevelSize(depthPyramid, level);
    let cell = depthPyramidCell(uv, size);
    // Parameter where the ray leaves this cell; the epsilon lands in the next one.
    var exitU = 1.0;
    for (var axis = 0u; axis < 2u; axis++) {
      if (abs(delta[axis]) > 1e-8) {
        let edge = (f32(cell[axis]) + select(0.0, 1.0, delta[axis] > 0.0)) / f32(size[axis]);
        exitU = min(exitU, (edge - uv0[axis]) / delta[axis]);
      }
    }
    exitU = min(max(exitU, u) + 0.25 / pixels, 1.0);
    let distanceAt = select(mix(w0, w1, u), 1.0 / mix(1.0 / w0, 1.0 / w1, u), perspective);
    let distanceExit = select(mix(w0, w1, exitU), 1.0 / mix(1.0 / w0, 1.0 / w1, exitU), perspective);
    let rayNear = min(distanceAt, distanceExit);
    let rayFar = max(distanceAt, distanceExit);
    let scene = depthPyramidDepthOrEmpty(textureLoad(depthPyramid, vec2i(cell), i32(level)).r);
    // Free only if the whole segment is in front of the cell's closest depth.
    if (rayFar < scene) {
      u = exitU;
      level = min(level + 1u, maxLevel);
      let s = select(u, (distanceExit - w0) / (w1 - w0), abs(w1 - w0) > 1e-6);
      freeT = clamp(s, 0.0, 1.0) * tMax;
      continue;
    }
    if (level > 0u) { level--; continue; }
    if (rayNear <= scene * (1.0 + thickness)) {
      let pixel = min(vec2u(uv * extent), extentSize() - vec2u(1u));
      let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
      let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
      if (validDepth(z) && dot(normal, d) < 0.0) {
        let radiance = previousRadiance(worldPosition(pixel, z));
        if (radiance.w > 0.0) {
          ray.radiance = radiance.xyz;
          ray.info = withStatus(ray.info, STATUS_RESOLVED);
          rays[i] = ray;
          return;
        }
      }
      break;
    }
    // Behind a surface the depth buffer proves nothing further: a later hit may
    // lie beyond a thin occluder (UE bUncertain), so the world ray takes over
    // from the last proven-free distance.
    break;
  }
  ray.tStart = max(freeT - thickness * w0, 0.0);
  rays[i] = ray;
}

// One workgroup per probe, one thread per texel: average the texel's rays.
// Culled or unresolved texels sample the world radiance cache along the texel's
// direction; an 8x8 octahedral texel subtends the cache's finest (0.25 rad) cone.
@compute @workgroup_size(64) fn resolveProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  if (!probeLive(probe)) { radianceOut[index] = vec4f(0.0); return; }
  var sum = vec3f(0.0);
  var count = 0.0;
  var incomplete = false;
  for (var r = 0u; r < 64u; r++) {
    let ray = raysIn[probe * 64u + r];
    if ((ray.info & RAY_USED) == 0u || (ray.info & 63u) != texel) { continue; }
    if (rayStatus(ray.info) == STATUS_INCOMPLETE) { incomplete = true; }
    if (rayStatus(ray.info) != STATUS_RESOLVED) { continue; }
    sum += ray.radiance;
    count += 1.0;
  }
  if (incomplete) { radianceOut[index] = vec4f(0.0, 0.0, 0.0, SUPPORT_INCOMPLETE); return; }
  if (count > 0.0) { radianceOut[index] = vec4f(sum / count, 1.0); return; }
  let fallback = sampleRadianceCache(probesIn[probe].position, texelDirection(texel), 0.25);
  radianceOut[index] = fallback;
}

// One workgroup per probe. Uniform probes average the same texel of their four
// neighbors weighted by plane/normal agreement (UE ScreenProbeFilterGather).
@compute @workgroup_size(64) fn filterProbeRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  let center = radianceIn[index];
  if (probe >= probeFrame.probes.x || !probeLive(probe) || center.w != 1.0) { radianceOut[index] = center; return; }
  let record = probesIn[probe];
  let tiles = tileCount();
  let tile = vec2i(vec2u(probe % tiles.x, probe / tiles.x));
  var sum = center.xyz;
  var total = 1.0;
  let offsets = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
  for (var k = 0u; k < 4u; k++) {
    let other = tile + offsets[k];
    if (any(other < vec2i(0)) || any(other >= vec2i(tiles))) { continue; }
    let neighbor = u32(other.y) * tiles.x + u32(other.x);
    if (!probeLive(neighbor)) { continue; }
    let value = radianceIn[neighbor * 64u + texel];
    if (value.w != 1.0) { continue; }
    let weight = probeAgreement(probesIn[neighbor], record.position, record.normal, record.distance);
    if (weight < 0.05) { continue; }
    sum += value.xyz * weight;
    total += weight;
  }
  radianceOut[index] = vec4f(sum / total, center.w);
}

var<workgroup> probeRadiance: array<vec4f, 64>;
var<workgroup> texelSolidAngle: array<f32, 64>;

// Octahedral texels are not equal-area: solid angle is proportional to
// 1 / |v|^3 at the (folded, unnormalized) octahedron point, so texels around
// the poles cover up to 2.8x less than texels at the equator.
fn octTexelSolidAngle(texel: u32) -> f32 {
  let p = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 4.0 - vec2f(1.0);
  var v = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (v.z < 0.0) { v = vec3f((vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), v.z); }
  let r = length(v);
  return 1.0 / (r * r * r);
}

// One workgroup per probe: D(n) per octahedral texel as the self-normalized,
// solid-angle-weighted cosine convolution of the probe radiance.
@compute @workgroup_size(64) fn convertProbeIrradiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  probeRadiance[texel] = radianceIn[index];
  texelSolidAngle[texel] = octTexelSolidAngle(texel);
  workgroupBarrier();
  if (!probeLive(probe)) { probeIrradianceOut[index] = vec4f(0.0); return; }
  let n = texelDirection(texel);
  var sum = vec3f(0.0);
  var total = 0.0;
  var support = 1.0;
  for (var t = 0u; t < 64u; t++) {
    let c = max(dot(n, texelDirection(t)), 0.0) * texelSolidAngle[t];
    if (c > 0.0) { support = min(support, probeRadiance[t].w); }
    sum += probeRadiance[t].xyz * c;
    total += c;
  }
  if (support != 1.0) { probeIrradianceOut[index] = vec4f(0.0, 0.0, 0.0, support); return; }
  probeIrradianceOut[index] = vec4f(sum / max(total, 1e-6), 1.0);
}

fn probeIrradianceAt(probe: u32, direction: vec3f) -> vec4f {
  let xy = clamp((spOctEncode(direction) * 0.5 + vec2f(0.5)) * 8.0 - vec2f(0.5), vec2f(0.0), vec2f(7.0));
  let base = vec2u(min(floor(xy), vec2f(6.0)));
  let f = xy - vec2f(base);
  var sum = vec3f(0.0);
  var support = 1.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let axis = select(vec2f(1.0) - f, f, offset > vec2u(0u));
    let c = base + offset;
    let weight = axis.x * axis.y;
    let value = probeIrradiance[probe * 64u + c.y * 8u + c.x];
    if (weight > 0.0) { support = min(support, value.w); }
    sum += value.xyz * weight;
  }
  if (support != 1.0) { return vec4f(0.0, 0.0, 0.0, support); }
  return vec4f(sum, 1.0);
}

struct ShortRange { occlusion: f32, bent: vec3f }

// Short-range screen-space horizon AO and bent normal within `radius` world
// units. The probes cannot resolve contact occlusion below their spacing.
fn shortRange(pixel: vec2u, position: vec3f, normal: vec3f) -> ShortRange {
  let radius = probeFrame.tuning.y;
  if (radius <= 0.0) { return ShortRange(1.0, normal); }
  let extent = vec2f(extentSize());
  let toView = normalize(view.cameraPos - position);
  var tangent = cross(toView, normal);
  if (dot(tangent, tangent) < 1e-6) { tangent = cross(vec3f(0.0, 1.0, 0.0), normal); }
  if (dot(tangent, tangent) < 1e-6) { tangent = vec3f(1.0, 0.0, 0.0); }
  let c0 = view.worldViewProj * vec4f(position, 1.0);
  let c1 = view.worldViewProj * vec4f(position + normalize(tangent) * radius, 1.0);
  let span = length((c1.xy / c1.w - c0.xy / c0.w) * 0.5 * extent);
  if (!(span >= 1.0)) { return ShortRange(1.0, normal); }
  let rotation = spUnit(packPixel(pixel) ^ (probeFrame.probes.w * 2654435761u)) * 6.28318530718;
  var occlusion = 0.0;
  var bent = vec3f(0.0);
  var samples = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let angle = rotation + f32(k) * 1.57079632679;
    let direction = vec2f(cos(angle), sin(angle));
    for (var s = 1u; s <= 6u; s++) {
      let offset = direction * span * (f32(s) - 0.5) / 6.0;
      let q = vec2i(vec2f(pixel) + vec2f(0.5) + offset);
      if (any(q < vec2i(0)) || any(q >= vec2i(extentSize()))) { continue; }
      let z = textureLoad(gbufferDepth, q, 0);
      if (!validDepth(z)) { continue; }
      let v = worldPosition(vec2u(q), z) - position;
      let len = length(v);
      samples += 1.0;
      if (len <= 1e-5 || len >= radius) { continue; }
      let h = max(dot(normal, v / len) - 0.1, 0.0) * (1.0 - (len * len) / (radius * radius));
      occlusion += h;
      bent += v / len * h;
    }
  }
  if (samples == 0.0) { return ShortRange(1.0, normal); }
  let ao = clamp(1.0 - 2.0 * occlusion / samples, 0.0, 1.0);
  let bentNormal = normalize(normal - bent / samples);
  return ShortRange(ao, select(normal, bentNormal, dot(bentNormal, normal) > 0.0));
}

// One thread per pixel: blend the bilinear uniform probes and the tile's
// adaptive probes, sample D at the bent normal and apply short-range AO once.
@compute @workgroup_size(64) fn integrateScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  integratedOut[i] = vec4f(0.0);
  if (!gbufferMatches()) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return; }
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let distance = length(view.cameraPos - position);
  let near = shortRange(pixel, position, normal);
  let tiles = tileCount();
  let ds = f32(probeFrame.probes.z);
  let g = clamp((vec2f(pixel) + vec2f(0.5)) / ds - vec2f(0.5), vec2f(0.0), vec2f(tiles - vec2u(1u)));
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  var source: array<ScreenProbe, 4>;
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probesIn[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, position, normal, distance, &source);
  var sum = vec3f(0.0);
  var total = 0.0;
  var incomplete = false;
  for (var tap = 0u; tap < 4u; tap++) {
    let w = taps.weights[tap];
    if (w > 1e-4) {
      let value = probeIrradianceAt(taps.probes[tap], near.bent);
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
    }
  }
  let ownTile = min(pixel / probeFrame.probes.z, tiles - vec2u(1u));
  let sub = min((pixel % probeFrame.probes.z) / max(probeFrame.probes.z / 2u, 1u), vec2u(1u));
  let adaptive = tileAdaptiveIn[(ownTile.y * tiles.x + ownTile.x) * 4u + (sub.x | (sub.y << 1u))];
  if (adaptive != SCREEN_PROBE_NONE && probeLive(adaptive)) {
    let w = probeAgreement(probesIn[adaptive], position, normal, distance);
    if (w > 1e-4) {
      let value = probeIrradianceAt(adaptive, near.bent);
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
    }
  }
  if (incomplete) { return; }
  if (total > 1e-3) {
    integratedOut[i] = vec4f(sum / total * near.occlusion, 1.0);
    return;
  }
  // World fallback: the persistent Irradiance Field.
  let toView = view.cameraPos - position;
  let value = sampleIrradianceField(position, normal, toView / max(length(toView), 1e-8));
  if (value.w > 0.0) { integratedOut[i] = vec4f(value.xyz * near.occlusion, 1.0); }
}

fn packNormal(n: vec3f) -> u32 { return pack2x16snorm(spOctEncode(n)); }
fn unpackNormal(p: u32) -> vec3f { return spOctDecode(unpack2x16snorm(p)); }

// One thread per pixel: reproject last frame's accumulated irradiance and
// reject on distance/normal disagreement (UE ScreenProbeTemporalReprojection).
@compute @workgroup_size(64) fn temporalScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let current = integrated[i];
  historyOut[i] = vec4f(0.0);
  metaOut[i] = vec4u(0u);
  if (current.w != 1.0 || !gbufferMatches()) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  var count = 1u;
  var value = current.xyz;
  if ((probeFrame.control.z & 2u) != 0u) {
    let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
    let uv = clip.xy / max(clip.w, 1e-8) * vec2f(0.5, -0.5) + vec2f(0.5);
    if (clip.w > 0.0 && all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let previous = min(vec2u(uv * vec2f(extent)), extent - vec2u(1u));
      let state = metaIn[pixelIndex(previous)];
      let expected = length(probeFrame.previousCameraPos.xyz - position);
      let stored = bitcast<f32>(state.x);
      if (state.w == 1u && abs(stored - expected) <= 0.02 * expected &&
          dot(unpackNormal(state.y), normal) > 0.7071) {
        count = min(state.z + 1u, probeFrame.control.w);
        value = mix(historyIn[pixelIndex(previous)].xyz, current.xyz, 1.0 / f32(count));
      }
    }
  }
  historyOut[i] = vec4f(value, 1.0);
  metaOut[i] = vec4u(bitcast<u32>(length(view.cameraPos - position)), packNormal(normal), count, 1u);
}

// After the composite: keep this frame's linear HDR scene for next frame's screen trace.
@compute @workgroup_size(64) fn copySceneHistory(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  if (any(textureDimensions(sceneColor) != extent)) { previousSceneOut[i] = vec2u(0u); return; }
  let color = textureLoad(sceneColor, vec2i(vec2u(i % extent.x, i / extent.x)), 0);
  let safe = select(vec3f(0.0), color.xyz, all(color.xyz >= vec3f(0.0)) && all(color.xyz < vec3f(65504.0)));
  previousSceneOut[i] = vec2u(pack2x16float(safe.xy), pack2x16float(vec2f(safe.z, 1.0)));
}
