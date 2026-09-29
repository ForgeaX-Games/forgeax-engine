#define_import_path forgeax_ray::path_tracer
#import forgeax_material::ray_abi::{RayMaterialInput, RayMaterialSurface}
#import forgeax_pbr::ray_bsdf::{rayBasis, rayBsdfValue, rayBsdfPdf, sampleRayBsdf, rayPowerHeuristic}
#import forgeax_pbr::lighting_attenuation::{evalDistanceAttenuation, evalSpotAttenuation}

#import forgeax_ray::traversal::{Triangle, Node, Ray, Hit, TraceResult, triangles, nodes, traceReference, traceReferenceAfter}

struct AttributeVertex { objectPosition: vec4f, color: vec4f, uvA: vec4f, uvB: vec4f, uvC: vec4f, uvD: vec4f, normal: vec4f, tangent: vec4f }
struct Attributes { a: AttributeVertex, b: AttributeVertex, c: AttributeVertex }
struct PathState { origin: vec4f, direction: vec4f, throughput: vec4f, radiance: vec4f, state: vec4u }
struct Accumulation { mean: vec3f, count: u32, m2: vec3f, error: u32, albedo: vec4f, normalDepth: vec4f, identity: vec4u }
struct TraceLight { positionKind: vec4f, radiance: vec4f, directionRange: vec4f, cone: vec4f }
struct TraceSettings { origin: vec4f, forward: vec4f, right: vec4f, up: vec4f, environment: vec4f, dimensions: vec4u }
@group(0) @binding(2) var<storage, read> attributes: array<Attributes>;
@group(0) @binding(3) var<storage, read_write> paths: array<PathState>;
@group(0) @binding(4) var<storage, read_write> inputs: array<RayMaterialInput>;
@group(0) @binding(5) var<storage, read_write> surfaces: array<RayMaterialSurface>;
@group(0) @binding(6) var<storage, read_write> accumulation: array<Accumulation>;
@group(0) @binding(7) var<uniform> lights: array<TraceLight, 32>;
@group(0) @binding(8) var<uniform> settings: TraceSettings;
// One reusable wavefront query per pixel. Original shading state survives shadow queries.
// state: pending/accepted-or-blocked/clear/invalid, last triangle, light index, reserved.
struct CoverageQuery {
  input: RayMaterialInput, surface: RayMaterialSurface,
  origin: vec4f, direction: vec4f, contribution: vec4f, state: vec4u,
}
@group(0) @binding(9) var<storage, read_write> coverage: array<CoverageQuery>;

fn random(state: ptr<function,u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
  return f32(((word >> 22u) ^ word) >> 8u) * (1.0 / 16777216.0);
}
fn epsilon(position: vec3f) -> f32 { return max(1e-4, max(max(abs(position.x),abs(position.y)),abs(position.z))*1e-5); }
fn visible(position: vec3f, normal: vec3f, direction: vec3f, distance: f32) -> bool {
  let offset = epsilon(position);
  let ray = Ray(position + normal*offset, 0.0, direction, max(0.0,distance-offset*2.0), vec4u(255u,0u,0u,0u));
  return traceReference(ray).hit.ids.x == 0xffffffffu;
}
fn uvDensity(a: vec2f, b: vec2f, c: vec2f, e: vec3f, f: vec3f) -> f32 {
  let ee = dot(e,e); let ef = dot(e,f); let ff = dot(f,f);
  let det = ee*ff-ef*ef;
  let ab = b-a; let ac = c-a;
  let gu = ((ab.x*ff-ac.x*ef)*e + (ac.x*ee-ab.x*ef)*f)/det;
  let gv = ((ab.y*ff-ac.y*ef)*e + (ac.y*ee-ab.y*ef)*f)/det;
  return sqrt(dot(gu,gu)+dot(gv,gv));
}
fn interpolateVertex(a: AttributeVertex, b: AttributeVertex, c: AttributeVertex, w: vec3f) -> AttributeVertex {
  return AttributeVertex(a.objectPosition*w.x+b.objectPosition*w.y+c.objectPosition*w.z,
    clamp(a.color+(b.color-a.color)*w.y+(c.color-a.color)*w.z,vec4f(0),vec4f(1)), a.uvA*w.x+b.uvA*w.y+c.uvA*w.z,
    a.uvB*w.x+b.uvB*w.y+c.uvB*w.z, a.uvC*w.x+b.uvC*w.y+c.uvC*w.z,
    a.uvD*w.x+b.uvD*w.y+c.uvD*w.z, a.normal*w.x+b.normal*w.y+c.normal*w.z,
    a.tangent*w.x+b.tangent*w.y+c.tangent*w.z);
}
fn materialInput(traced: TraceResult, ray: Ray, coneWidth: f32, coneSpread: f32, bounce: u32) -> RayMaterialInput {
  let hit = traced.hit;
  let triangle = triangles[traced.triangleIndex]; let attr = attributes[traced.triangleIndex];
  let w = vec3f(1.0-hit.metrics.y-hit.metrics.z,hit.metrics.yz);
  let vertex = interpolateVertex(attr.a,attr.b,attr.c,w);
  let e = triangle.b.xyz-triangle.a.xyz; let f = triangle.c.xyz-triangle.a.xyz;
  let normal = normalize(cross(e,f))*attr.a.normal.w; let position = ray.origin+ray.direction*hit.metrics.x;
  let cone = coneWidth + hit.metrics.x*coneSpread;
  let footprint = cone/max(abs(dot(normal,ray.direction)),0.001);
  let densityA = vec4f(uvDensity(attr.a.uvA.xy,attr.b.uvA.xy,attr.c.uvA.xy,e,f),uvDensity(attr.a.uvA.zw,attr.b.uvA.zw,attr.c.uvA.zw,e,f),
    uvDensity(attr.a.uvB.xy,attr.b.uvB.xy,attr.c.uvB.xy,e,f),uvDensity(attr.a.uvB.zw,attr.b.uvB.zw,attr.c.uvB.zw,e,f));
  let densityB = vec4f(uvDensity(attr.a.uvC.xy,attr.b.uvC.xy,attr.c.uvC.xy,e,f),uvDensity(attr.a.uvC.zw,attr.b.uvC.zw,attr.c.uvC.zw,e,f),
    uvDensity(attr.a.uvD.xy,attr.b.uvD.xy,attr.c.uvD.xy,e,f),uvDensity(attr.a.uvD.zw,attr.b.uvD.zw,attr.c.uvD.zw,e,f));
  return RayMaterialInput(vertex.objectPosition,vec4f(position,hit.metrics.x),vec4f(normal,select(0.0,1.0,dot(normal,ray.direction)<0.0)),
    vertex.tangent,vec4f(-ray.direction,cone),vertex.uvA,vertex.uvB,vertex.uvC,vertex.uvD,vertex.color,
    densityA*footprint,densityB*footprint,vertex.normal,vec4u(hit.ids.w,1u,bounce,traced.triangleIndex));
}
@compute @workgroup_size(64) fn generate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  var rng = (id.x+1u)*2654435761u ^ (accumulation[id.x].count+1u)*2246822519u ^ settings.dimensions.w;
  let jitter = vec2f(random(&rng),random(&rng));
  let pixel = vec2f(f32(id.x % settings.dimensions.x), f32(id.x/settings.dimensions.x));
  let ndc = ((pixel+jitter)/vec2f(settings.dimensions.xy))*2.0-vec2f(1.0);
  let direction = normalize(settings.forward.xyz + ndc.x*settings.right.xyz - ndc.y*settings.up.xyz);
  paths[id.x] = PathState(vec4f(settings.origin.xyz,0.0),vec4f(direction,settings.origin.w),vec4f(1,1,1,0),vec4f(0),vec4u(1u,0u,rng,0u));
  accumulation[id.x].identity = vec4u(0xffffffffu);
  accumulation[id.x].albedo = vec4f(0);
  accumulation[id.x].normalDepth = vec4f(0,0,0,-1);
}
@compute @workgroup_size(64) fn trace(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  if (settings.forward.w != 0.0 && coverage[id.x].state.x != 0u) { return; }
  inputs[id.x].identity = vec4u(0xffffffffu,0u,0u,0u);
  surfaces[id.x].status = vec4u(0u);
  var path = paths[id.x];
  if (path.state.x == 0u) { return; }
  let ray = Ray(path.origin.xyz,0.0,path.direction.xyz,settings.environment.w,vec4u(255u,0u,0u,0u));
  var afterT=0.0; var afterTriangle=0xffffffffu;
  if (settings.forward.w != 0.0) { afterT=coverage[id.x].contribution.w; afterTriangle=coverage[id.x].state.y; }
  let traced=traceReferenceAfter(ray,afterT,afterTriangle);
  let hit = traced.hit;
  if (hit.ids.x == 0xffffffffu) {
    if (path.state.y == 0u) { accumulation[id.x].identity=vec4u(0xffffffffu); }
    var mis = 1.0;
    if (path.state.y > 0u) { mis = rayPowerHeuristic(path.throughput.w, 1.0/6.28318530718); }
    path.radiance += vec4f(path.throughput.xyz*settings.environment.xyz*mis,0);
    path.state.x = 0u; paths[id.x] = path;
    if (settings.forward.w != 0.0) { coverage[id.x].state.x = 1u; }
    return;
  }
  inputs[id.x] = materialInput(traced, ray, path.origin.w, path.direction.w, path.state.y);
  if (path.state.y == 0u) { accumulation[id.x].identity = hit.ids; }
  // Opaque coverage is known without running its Surface program in every candidate round.
  if (settings.forward.w != 0.0 && triangles[traced.triangleIndex].maskData.z == 0u) { coverage[id.x].state.x=1u; }
}
@compute @workgroup_size(64) fn shade(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  var path = paths[id.x];
  if (path.state.x == 0u) { return; }
  let input = inputs[id.x]; let surface = surfaces[id.x];
  if (surface.status.x != 1u) { path.state.x=0u; path.radiance.w=1.0; paths[id.x]=path; return; }
  let n = surface.normalRoughness.xyz; let outgoing = input.outgoing.xyz; let position = input.positionWS.xyz;
  let ng = surface.geometricNormal.xyz;
  if (path.state.y == 0u) {
    accumulation[id.x].albedo = surface.albedoOpacity;
    accumulation[id.x].normalDepth = vec4f(n,input.positionWS.w);
  }
  // Emissive surfaces are BSDF-sampled only in this baseline, so no competing
  // emitter NEE term exists and this contribution has weight one.
  var radiance = surface.emissionMetallic.xyz;
  var rng=path.state.z;
  if (settings.forward.w == 0.0) {
  for (var i=0u; i<u32(settings.right.w); i++) {
    let light=lights[i]; let kind=u32(light.positionKind.w);
    if (kind == 0u) { continue; }
    var incoming=normalize(-light.directionRange.xyz); var distance=settings.environment.w; var scale=1.0;
    if (kind >= 2u) {
      let delta=light.positionKind.xyz-position; distance=length(delta);
      incoming=delta/max(distance,1e-8);
      scale=evalDistanceAttenuation(distance*distance,light.directionRange.w);
      if (kind == 3u) { scale=evalSpotAttenuation(light.positionKind.xyz,light.directionRange.xyz,position,light.cone.x,light.cone.y,light.directionRange.w); }
    }
    let cosine=max(dot(n,incoming),0.0);
    if (cosine > 0.0 && dot(ng,incoming)>0.0 && visible(position,ng,incoming,distance)) { radiance += rayBsdfValue(surface,outgoing,incoming)*light.radiance.xyz*(scale*cosine); }
  }
  let z=random(&rng); let phi=6.28318530718*random(&rng); let r=sqrt(1.0-z*z);
  let environmentDirection=rayBasis(n)*vec3f(r*cos(phi),r*sin(phi),z);
  let environmentPdf=1.0/6.28318530718;
  if (any(settings.environment.xyz > vec3f(0)) && dot(ng,environmentDirection)>0.0 && visible(position,ng,environmentDirection,settings.environment.w)) {
    var weight=rayPowerHeuristic(environmentPdf,rayBsdfPdf(surface,outgoing,environmentDirection));
    if (path.state.y+1u >= settings.dimensions.z) { weight=1.0; }
    radiance += rayBsdfValue(surface,outgoing,environmentDirection)*settings.environment.xyz*(z*weight/environmentPdf);
  }
  }
  path.radiance += vec4f(path.throughput.xyz*radiance,0);
  let sample=sampleRayBsdf(surface,outgoing,vec3f(random(&rng),random(&rng),random(&rng)));
  path.throughput=vec4f(path.throughput.xyz*sample.weight,sample.pdf);
  path.state.y++;
  path.state.x=sample.valid;
  if (path.state.y >= 3u && path.state.x != 0u) {
    let q=clamp(max(max(path.throughput.x,path.throughput.y),path.throughput.z),0.05,0.95);
    if (random(&rng) >= q) { path.state.x=0u; } else { path.throughput=vec4f(path.throughput.xyz/q,path.throughput.w); }
  }
  if (path.state.y >= settings.dimensions.z) { path.state.x=0u; }
  path.state.z=rng;
  path.origin=vec4f(position+ng*epsilon(position),input.outgoing.w);
  path.direction=vec4f(sample.direction,max(path.direction.w,surface.normalRoughness.w*surface.normalRoughness.w));
  if (!all(abs(path.radiance.xyz) < vec3f(1e30)) || !all(abs(path.throughput.xyz) < vec3f(1e30))) { path.radiance=vec4f(0,0,0,1); path.state.x=0u; }
  paths[id.x]=path;
}
@compute @workgroup_size(64) fn accumulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  let value=paths[id.x].radiance;
  var a=accumulation[id.x];
  if (value.w != 0.0) { a.error=1u; accumulation[id.x]=a; return; }
  a.count++;
  let delta=value.xyz-a.mean; a.mean+=delta/f32(a.count); a.m2+=delta*(value.xyz-a.mean);
  accumulation[id.x]=a;
}

@compute @workgroup_size(64) fn beginCoverage(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  coverage[id.x].state=vec4u(select(1u,0u,paths[id.x].state.x!=0u),0xffffffffu,0u,0u);
  coverage[id.x].contribution=vec4f(0);
}
@compute @workgroup_size(64) fn acceptCoverage(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths) || coverage[id.x].state.x != 0u) { return; }
  let input=inputs[id.x]; let surface=surfaces[id.x];
  if (surface.status.x == 3u) {
    coverage[id.x].contribution.w=input.positionWS.w;
    coverage[id.x].state.y=input.identity.w;
  } else {
    coverage[id.x].state.x=1u;
    if (surface.status.x != 1u) { paths[id.x].radiance.w=1.0; paths[id.x].state.x=0u; }
  }
}
@compute @workgroup_size(64) fn sealCoverage(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  // Exhaustion is an invalid sample, never an unoccluded approximation.
  if (coverage[id.x].state.x == 0u) { paths[id.x].radiance.w=1.0; paths[id.x].state.x=0u; }
  coverage[id.x].input=inputs[id.x]; coverage[id.x].surface=surfaces[id.x];
}
@compute @workgroup_size(64) fn beginShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  var q=coverage[id.x];
  q.state.x=1u; q.state.y=0xffffffffu; q.contribution=vec4f(0);
  inputs[id.x].identity.y=0u;
  if (paths[id.x].state.x == 0u) { coverage[id.x]=q; return; }
  let surface=q.surface; let input=q.input; let position=input.positionWS.xyz;
  let n=surface.normalRoughness.xyz; let ng=surface.geometricNormal.xyz; let outgoing=input.outgoing.xyz;
  var incoming=vec3f(0); var distance=settings.environment.w; var incident=vec3f(0);
  if (q.state.z < u32(settings.right.w)) {
    let light=lights[q.state.z]; let kind=u32(light.positionKind.w);
    incoming=normalize(-light.directionRange.xyz); var scale=1.0;
    if (kind >= 2u) {
      let delta=light.positionKind.xyz-position; distance=length(delta); incoming=delta/max(distance,1e-8);
      scale=evalDistanceAttenuation(distance*distance,light.directionRange.w);
      if (kind == 3u) { scale=evalSpotAttenuation(light.positionKind.xyz,light.directionRange.xyz,position,light.cone.x,light.cone.y,light.directionRange.w); }
    }
    incident=light.radiance.xyz*scale*max(dot(n,incoming),0.0);
  } else {
    var rng=paths[id.x].state.z;
    let z=random(&rng); let phi=6.28318530718*random(&rng); let r=sqrt(1.0-z*z);
    incoming=rayBasis(n)*vec3f(r*cos(phi),r*sin(phi),z);
    let pdf=1.0/6.28318530718;
    var weight=rayPowerHeuristic(pdf,rayBsdfPdf(surface,outgoing,incoming));
    if (paths[id.x].state.y+1u >= settings.dimensions.z) { weight=1.0; }
    incident=settings.environment.xyz*(z*weight/pdf);
    paths[id.x].state.z=rng;
  }
  let contribution=rayBsdfValue(surface,outgoing,incoming)*incident;
  if (dot(ng,incoming)>0.0 && any(contribution>vec3f(0))) {
    q.state.x=0u;
    let offset=epsilon(position);
    q.origin=vec4f(position+ng*offset,input.outgoing.w);
    q.direction=vec4f(incoming,max(0.0,distance-offset*2.0));
    q.contribution=vec4f(contribution,0);
  }
  coverage[id.x]=q;
}
@compute @workgroup_size(64) fn traceShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  inputs[id.x].identity.y=0u; surfaces[id.x].status.x=0u;
  var q=coverage[id.x];
  if (q.state.x != 0u) { return; }
  let ray=Ray(q.origin.xyz,0.0,q.direction.xyz,q.direction.w,vec4u(255u,0u,0u,0u));
  let traced=traceReferenceAfter(ray,q.contribution.w,q.state.y);
  if (traced.hit.ids.x == 0xffffffffu) { coverage[id.x].state.x=2u; return; }
  // The producer marks only materials requiring coverage evaluation.
  if (triangles[traced.triangleIndex].maskData.z == 0u) { coverage[id.x].state.x=1u; return; }
  inputs[id.x]=materialInput(traced,ray,q.origin.w,0.0,paths[id.x].state.y);
}
@compute @workgroup_size(64) fn acceptShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths) || coverage[id.x].state.x != 0u) { return; }
  let input=inputs[id.x]; let surface=surfaces[id.x];
  if (surface.status.x == 3u) {
    coverage[id.x].contribution.w=input.positionWS.w;
    coverage[id.x].state.y=input.identity.w;
  } else { coverage[id.x].state.x=select(3u,1u,surface.status.x==1u); }
}
@compute @workgroup_size(64) fn endShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  let q=coverage[id.x];
  if (q.state.x == 2u) { paths[id.x].radiance+=vec4f(paths[id.x].throughput.xyz*q.contribution.xyz,0); }
  if (q.state.x == 0u || q.state.x == 3u) { paths[id.x].radiance.w=1.0; paths[id.x].state.x=0u; }
  inputs[id.x]=q.input; surfaces[id.x]=q.surface;
  coverage[id.x].state.z++;
}
