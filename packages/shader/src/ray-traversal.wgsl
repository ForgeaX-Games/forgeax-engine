#define_import_path forgeax_ray::traversal

struct Triangle { a: vec4f, b: vec4f, c: vec4f, ids: vec4u, maskData: vec4u }
struct Node { lo: vec3f, escape: u32, hi: vec3f, first: u32, count: u32, paddingA: u32, paddingB: u32, paddingC: u32 }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, maskData: vec4u }
struct Hit { ids: vec4u, metrics: vec4f }
fn boxHit(ray: Ray, node: Node, maximum: f32) -> bool {
  var near = ray.tMin; var far = maximum;
  for (var axis = 0u; axis < 3u; axis++) {
    if (ray.direction[axis] == 0.0) {
      if (ray.origin[axis] < node.lo[axis] || ray.origin[axis] > node.hi[axis]) { return false; }
    } else {
      let a = (node.lo[axis] - ray.origin[axis]) / ray.direction[axis];
      let b = (node.hi[axis] - ray.origin[axis]) / ray.direction[axis];
      near = max(near, min(a,b)); far = min(far, max(a,b));
      if (near > far) { return false; }
    }
  }
  return true;
}
struct TraceResult { hit: Hit, triangleIndex: u32 }
// Cursor is a (distance, ordered triangle) pair. Advancing tMin would lose
// coplanar or very closely layered surfaces after a rejected alpha candidate.
fn traceReferenceAfter(ray: Ray, afterT: f32, afterTriangle: u32) -> TraceResult {
  var triangleIndex = 0xffffffffu;
  var result = Hit(vec4u(0xffffffffu), vec4f(-1.0, 0.0, 0.0, 0.0));
  var closest = ray.tMax;
  var nodeIndex = 0u;
  loop {
    if (nodeIndex >= arrayLength(&nodes)) { break; }
    let node = nodes[nodeIndex];
    if (!boxHit(ray, node, closest)) {
      // Empty-scene dummy has escape=0. Always make forward progress.
      nodeIndex = max(nodeIndex + 1u, node.escape); continue;
    }
    for (var i = node.first; i < node.first + node.count; i++) {
      let triangle = triangles[i];
      if ((triangle.maskData.x & ray.maskData.x) == 0u) { continue; }
      let e1 = triangle.b.xyz - triangle.a.xyz;
      let e2 = triangle.c.xyz - triangle.a.xyz;
      let p = cross(ray.direction, e2); let det = dot(e1, p);
      if (det == 0.0 || (triangle.maskData.y == 1u && det < 0.0) || (triangle.maskData.y == 2u && det > 0.0)) { continue; }
      let s = ray.origin - triangle.a.xyz;
      let u = dot(s, p) / det;
      let q = cross(s, e1); let v = dot(ray.direction, q) / det;
      let t = dot(e2, q) / det;
      if (u < 0.0 || v < 0.0 || u + v > 1.0 || t < ray.tMin || t > closest) { continue; }
      if (afterTriangle != 0xffffffffu && (t < afterT || (t == afterT && i <= afterTriangle))) { continue; }
      if (result.ids.x != 0xffffffffu && t == closest && i >= triangleIndex) { continue; }
      closest = t;
      triangleIndex = i;
      result = Hit(triangle.ids, vec4f(t, u, v, select(0.0, 1.0, det > 0.0)));
    }
    nodeIndex++;
  }
  return TraceResult(result, triangleIndex);
}
fn traceReference(ray: Ray) -> TraceResult {
  return traceReferenceAfter(ray, 0.0, 0xffffffffu);
}

@group(0) @binding(0) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
