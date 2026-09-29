import { err, ok, type Result } from '@forgeax/engine-types';

/** Experimental opaque reference profile. Distances are ray parameters, not normalized lengths. */
export interface RayMeshInstance {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly materialId: number;
  readonly mask: number;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Column-major affine object-to-world transform. */
  readonly transform: ArrayLike<number>;
}

/** Geometry/pose identity shared by traversal and capture; representation settings are separate. */
export function rayGeometryKey(
  instance: Pick<RayMeshInstance, 'instanceId' | 'geometryId' | 'mask' | 'transform'>,
  meshDigest: string,
): string {
  return JSON.stringify([
    instance.instanceId,
    instance.geometryId,
    instance.mask,
    Array.from(instance.transform),
    meshDigest,
  ]);
}

export interface ReferenceRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly tMin: number;
  readonly tMax: number;
  readonly mask: number;
}

export interface ReferenceHit {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly primitiveId: number;
  readonly materialId: number;
  readonly t: number;
  readonly barycentrics: readonly [number, number];
  readonly frontFace: boolean;
}

export interface RayReferenceError {
  readonly code: 'ray-reference-invalid' | 'ray-reference-limit' | 'ray-reference-stale';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly cause: string };
}

export const RAY_REFERENCE_LIMIT = 65_536;
// Traversal and expanded Surface attributes stay within the portable 128 MiB binding floor.
export const RAY_REFERENCE_TRIANGLE_LIMIT = 327_680;
export const RAY_TRIANGLE_STRIDE = 80;
export const RAY_NODE_STRIDE = 48;
export const RAY_INPUT_STRIDE = 48;
export const RAY_HIT_STRIDE = 32;

/** Owned f32 world-space snapshot; rebuilding replaces all geometry, masks and identities atomically. */
export interface RayReferenceScene {
  readonly triangles: Uint8Array;
  readonly nodes: Uint8Array;
  readonly triangleCount: number;
}

export function rayReferenceFailure(
  cause: string,
  limit = false,
): Result<never, RayReferenceError> {
  return err({
    code: limit ? 'ray-reference-limit' : 'ray-reference-invalid',
    expected:
      'finite opaque indexed triangles and finite nonzero rays within the reference profile',
    hint: 'Inspect the input; rebuild a bounded scene snapshot before submitting queries.',
    detail: { cause },
  });
}

const uint = (value: number, max = 0xffffffff) =>
  Number.isInteger(value) && value >= 0 && value <= max;
const finite32 = (value: number) => Number.isFinite(value) && Number.isFinite(Math.fround(value));

/** Builds a deterministic, stackless median BVH. Never borrows caller arrays. */
export function buildRayReferenceScene(
  instances: readonly RayMeshInstance[],
): Result<RayReferenceScene, RayReferenceError> {
  if (instances.length > 1024) return rayReferenceFailure('instance limit exceeded', true);
  const rows: number[][] = [];
  const ids = new Set<number>();
  for (const instance of instances) {
    const {
      instanceId,
      geometryId,
      materialId,
      mask,
      positions: p,
      indices,
      transform: m,
    } = instance;
    if (
      !uint(instanceId, 0xfffffffe) ||
      ids.has(instanceId) ||
      !uint(geometryId) ||
      !uint(materialId) ||
      !uint(mask, 255)
    )
      return rayReferenceFailure(
        'instance identities must be unique; IDs are u32 and masks are u8',
      );
    ids.add(instanceId);
    if (
      p.length === 0 ||
      p.length % 3 !== 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0 ||
      m.length !== 16
    )
      return rayReferenceFailure('expected nonempty xyz positions, triangle indices, and a mat4');
    if (rows.length + indices.length / 3 > RAY_REFERENCE_TRIANGLE_LIMIT)
      return rayReferenceFailure('triangle limit exceeded', true);
    if (
      !Array.from(p).every(finite32) ||
      !Array.from(m).every(finite32) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1
    )
      return rayReferenceFailure('positions and affine transforms must be finite f32');
    const det =
      item(m, 0) * (item(m, 5) * item(m, 10) - item(m, 9) * item(m, 6)) -
      item(m, 4) * (item(m, 1) * item(m, 10) - item(m, 9) * item(m, 2)) +
      item(m, 8) * (item(m, 1) * item(m, 6) - item(m, 5) * item(m, 2));
    if (!Number.isFinite(det) || det === 0) return rayReferenceFailure('singular transform');
    for (let primitive = 0; primitive < indices.length / 3; primitive++) {
      const row: number[] = [];
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = item(indices, primitive * 3 + vertex);
        if (!uint(index) || index * 3 + 2 >= p.length)
          return rayReferenceFailure('index outside positions');
        const x = item(p, index * 3),
          y = item(p, index * 3 + 1),
          z = item(p, index * 3 + 2);
        for (let axis = 0; axis < 3; axis++)
          row.push(
            Math.fround(
              item(m, axis) * x +
                item(m, 4 + axis) * y +
                item(m, 8 + axis) * z +
                item(m, 12 + axis),
            ),
          );
        row.push(0);
      }
      if (!row.every(finite32)) return rayReferenceFailure('world position overflow');
      const ab = [
        item(row, 4) - item(row, 0),
        item(row, 5) - item(row, 1),
        item(row, 6) - item(row, 2),
      ];
      const ac = [
        item(row, 8) - item(row, 0),
        item(row, 9) - item(row, 1),
        item(row, 10) - item(row, 2),
      ];
      // Zero-area source primitives have no coverage. Preserve IDs and counts, but
      // mark them inactive just as a hardware triangle AS does.
      const activeMask = cross(ab, ac).every((v) => v === 0) ? 0 : mask;
      rows.push([...row, instanceId, geometryId, primitive, materialId, activeMask, 0, 0, 0]);
    }
  }
  const nodes: { min: number[]; max: number[]; escape: number; first: number; count: number }[] =
    [];
  const ordered: number[][] = [];
  const visit = (items: number[][]): void => {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const row of items)
      for (let axis = 0; axis < 3; axis++)
        for (const v of [0, 4, 8]) {
          min[axis] = Math.min(item(min, axis), item(row, v + axis));
          max[axis] = Math.max(item(max, axis), item(row, v + axis));
        }
    const node = { min, max, escape: 0, first: ordered.length, count: 0 };
    nodes.push(node);
    if (items.length <= 4) {
      node.count = items.length;
      ordered.push(...items);
    } else {
      const axis = [0, 1, 2].sort(
        (a, b) => item(max, b) - item(min, b) - (item(max, a) - item(min, a)),
      )[0] as number;
      items.sort(
        (a, b) =>
          item(a, axis) +
          item(a, axis + 4) +
          item(a, axis + 8) -
          (item(b, axis) + item(b, axis + 4) + item(b, axis + 8)),
      );
      const middle = Math.floor(items.length / 2);
      visit(items.slice(0, middle));
      visit(items.slice(middle));
    }
    node.escape = nodes.length;
  };
  if (rows.length) visit(rows);
  // One unreachable dummy element keeps WebGPU runtime arrays bindable for an empty scene.
  const triangles = new Uint8Array(Math.max(1, rows.length) * RAY_TRIANGLE_STRIDE);
  const tv = new DataView(triangles.buffer);
  ordered.forEach((row, i) => {
    row.forEach((v, j) => {
      if (j < 12) tv.setFloat32(i * 80 + j * 4, v, true);
      else tv.setUint32(i * 80 + j * 4, v, true);
    });
  });
  const nodeBytes = new Uint8Array(Math.max(1, nodes.length) * RAY_NODE_STRIDE);
  const nv = new DataView(nodeBytes.buffer);
  nodes.forEach((n, i) => {
    for (let axis = 0; axis < 3; axis++) {
      nv.setFloat32(i * 48 + axis * 4, item(n.min, axis), true);
      nv.setFloat32(i * 48 + 16 + axis * 4, item(n.max, axis), true);
    }
    nv.setUint32(i * 48 + 12, n.escape, true);
    nv.setUint32(i * 48 + 28, n.first, true);
    nv.setUint32(i * 48 + 32, n.count, true);
  });
  return ok({ triangles, nodes: nodeBytes, triangleCount: rows.length });
}

export function packReferenceRays(
  rays: readonly ReferenceRay[],
): Result<Uint8Array, RayReferenceError> {
  if (!rays.length || rays.length > RAY_REFERENCE_LIMIT)
    return rayReferenceFailure('ray count must be 1..65536', true);
  const bytes = new Uint8Array(rays.length * RAY_INPUT_STRIDE),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < rays.length; i++) {
    const r = item(rays, i);
    if (
      r.origin.length !== 3 ||
      r.direction.length !== 3 ||
      ![...r.origin, ...r.direction, r.tMin, r.tMax].every(finite32) ||
      r.direction.every((v) => Math.fround(v) === 0) ||
      r.tMin < 0 ||
      Math.fround(r.tMax) <= Math.fround(r.tMin) ||
      !uint(r.mask, 255)
    )
      return rayReferenceFailure(`invalid ray ${i}`);
    [...r.origin, r.tMin, ...r.direction, r.tMax].forEach((v, j) => {
      view.setFloat32(i * 48 + j * 4, v, true);
    });
    view.setUint32(i * 48 + 32, r.mask, true);
  }
  return ok(bytes);
}

/** Independent f64 plane/Gram-matrix oracle: deliberately does not traverse the GPU BVH. */
export function traceReferenceRay(
  scene: RayReferenceScene,
  ray: ReferenceRay,
): ReferenceHit | null {
  const view = new DataView(
    scene.triangles.buffer,
    scene.triangles.byteOffset,
    scene.triangles.byteLength,
  );
  let best: ReferenceHit | null = null;
  for (let i = 0; i < scene.triangleCount; i++) {
    const base = i * 80;
    if (!(view.getUint32(base + 64, true) & ray.mask)) continue;
    const point = (offset: number) =>
      [0, 4, 8].map((a) => view.getFloat32(base + offset + a, true));
    const a = point(0),
      b = point(16),
      c = point(32);
    const ab = sub(b, a),
      ac = sub(c, a),
      normal = cross(ab, ac);
    const denom = dot(normal, ray.direction);
    if (denom === 0) continue;
    const t = dot(normal, sub(a, ray.origin)) / denom;
    if (t < ray.tMin || t > ray.tMax || (best !== null && t >= best.t)) continue;
    const q = ray.origin.map((o, axis) => o + item(ray.direction, axis) * t - item(a, axis));
    const bb = dot(ab, ab),
      cc = dot(ac, ac),
      bc = dot(ab, ac),
      qb = dot(q, ab),
      qc = dot(q, ac);
    const d = bb * cc - bc * bc;
    const u = (qb * cc - qc * bc) / d,
      v = (qc * bb - qb * bc) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    best = {
      instanceId: view.getUint32(base + 48, true),
      geometryId: view.getUint32(base + 52, true),
      primitiveId: view.getUint32(base + 56, true),
      materialId: view.getUint32(base + 60, true),
      t,
      barycentrics: [u, v],
      frontFace: denom < 0,
    };
  }
  return best;
}

function sub(a: ArrayLike<number>, b: ArrayLike<number>) {
  return [0, 1, 2].map((i) => item(a, i) - item(b, i));
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  return item(a, 0) * item(b, 0) + item(a, 1) * item(b, 1) + item(a, 2) * item(b, 2);
}
function cross(a: ArrayLike<number>, b: ArrayLike<number>) {
  return [
    item(a, 1) * item(b, 2) - item(a, 2) * item(b, 1),
    item(a, 2) * item(b, 0) - item(a, 0) * item(b, 2),
    item(a, 0) * item(b, 1) - item(a, 1) * item(b, 0),
  ];
}

// Inputs are validated once; this assertion also protects internal BVH indexing invariants.
function item<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new RangeError(`reference kernel index ${index} is outside its validated span`);
  return value;
}
