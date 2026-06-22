// @forgeax/engine-runtime — CPU cluster-forward binner (M3 pure functions)
// feat-20260608-cluster-lighting.
//
// Transplants Bevy's clustered_forward CPU math skeleton (research Finding 1)
// from WGSL to pure TypeScript. Four internal pure functions ported from
// Bevy cluster.wgsl lines 75-200:
//   cluster_space_object_aabb — sphere -> view-space NDC AABB
//   ndc_position_to_cluster   — NDC coords -> cluster index (XY+Z)
//   calculate_sphere_cluster_bounds — AABB -> cluster-cell range
//   view_z_to_z_slice        — log-z inverse mapping (idTech6 formula)
//
// Public surface:
//   bin(lights, view, proj, grid, near, far, clusterGrid, lightIndexList, capacity)
//     -> Result<void, ClusterBinError>
//
//   deriveCullingRadius(range, intensity, threshold) — D-8 +Infinity fallback
//
// Constraints:
//   D-3: pure function + Result<void, ClusterBinError> + out param + no throw
//   D-8: spot uses sphere proxy (radius=range)
//   D-binner: CPU main thread, no GPU compute / worker
//   OOS-4: cone-AABB tight culling deferred
//   AGENTS.md conventions: structured errors, never throw for expected failures
//
// Capacity: max 65536 light index list entries (hard cap, AC-24).
// Grid: {x,y,z} each in [1, 64] integers (validated at install time).

import { type Mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-rhi';

// ── types ──────────────────────────────────────────────────────────────────

export type ClusterBinErrorCode = 'index-overflow';

export interface ClusterBinError {
  readonly code: ClusterBinErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: IndexOverflowDetail;
}

export interface IndexOverflowDetail {
  readonly actual: number;
  readonly capacity: number;
}

/**
 * View-space NDC axis-aligned bounding box.
 * `min` and `max` are NDC coordinates clamped to [-1, 1] for XY;
 * Z may extend to projection-space depth values.
 */
export interface ClusterAabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Unsigned integer 3D cluster cell coordinate. */
export interface Uvec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Cluster cell range in the unsigned grid. */
export interface ClusterBounds {
  readonly min: Uvec3;
  readonly max: Uvec3;
}

// ── deriveCullingRadius ────────────────────────────────────────────────────

/**
 * Compute a culling radius for a punctual light.
 *
 * If `range` is finite, returns it verbatim (D-8 sphere proxy).
 * If `range === +Infinity`, derives a finite radius from the distance at which
 * the light's perceptible contribution drops below `threshold`.
 *
 * Formula: `sqrt(intensity / threshold)` gives the distance at which attenuation
 * = threshold (assuming E=1/r^2 falloff for point lights).
 * Cap to a conservative 1000 units to prevent overly large bounds.
 */
export function deriveCullingRadius(range: number, intensity: number, threshold = 0.001): number {
  if (Number.isFinite(range)) {
    return Math.max(0, range);
  }
  const derived = Math.sqrt(intensity / threshold);
  return Math.min(derived, 1000);
}

// ── view_z_to_z_slice ──────────────────────────────────────────────────────

/**
 * Map view-space z (negative, camera-forward) to a cluster Z slice index.
 *
 * Implements the idTech6 inverse log-z formula (research §2):
 *   slice = floor(log(-view_z / near) / log(far / near) * gridZ)
 *
 * Clamped to [0, gridZ - 1].
 */
export function viewZToZSlice(viewZ: number, gridZ: number, near: number, far: number): number {
  if (viewZ >= -near) {
    return 0;
  }
  const logFarOverNear = Math.log(far / near);
  const slice = Math.floor((Math.log(-viewZ / near) / logFarOverNear) * gridZ);
  if (slice < 0) return 0;
  if (slice >= gridZ) return gridZ - 1;
  return slice;
}

// ── cluster_space_object_aabb ───────────────────────────────────────────────

/**
 * Compute view-space NDC AABB for a sphere (light culling proxy).
 *
 * Ported from Bevy `cluster_space_object_aabb` (cluster.wgsl lines 75-140).
 *
 * Steps:
 *   1. Transform sphere center to view space via view matrix.
 *   2. Expand by radius to get view-AABB corners.
 *   3. Project 4 key corners to NDC.
 *   4. Clamp to [-1, 1] for XY ; Z is kept as projected depth.
 */
export function clusterSpaceObjectAabb(
  center: Vec3,
  radius: number,
  view: Mat4,
  proj: Mat4,
): ClusterAabb {
  const cx = center[0] ?? 0;
  const cy = center[1] ?? 0;
  const cz = center[2] ?? 0;

  const v00 = view[0] ?? 0;
  const v01 = view[1] ?? 0;
  const v02 = view[2] ?? 0;
  const v10 = view[4] ?? 0;
  const v11 = view[5] ?? 0;
  const v12 = view[6] ?? 0;
  const v20 = view[8] ?? 0;
  const v21 = view[9] ?? 0;
  const v22 = view[10] ?? 0;
  const v30 = view[12] ?? 0;
  const v31 = view[13] ?? 0;
  const v32 = view[14] ?? 0;

  const vx = v00 * cx + v10 * cy + v20 * cz + v30;
  const vy = v01 * cx + v11 * cy + v21 * cz + v31;
  const vz = v02 * cx + v12 * cy + v22 * cz + v32;

  const viewScaleX = Math.hypot(v00, v01, v02);
  const viewScaleY = Math.hypot(v10, v11, v12);
  const viewScaleZ = Math.hypot(v20, v21, v22);

  const rx = radius * viewScaleX;
  const ry = radius * viewScaleY;
  const rz = radius * viewScaleZ;

  const vMinX = vx - rx;
  const vMaxX = vx + rx;
  const vMinY = vy - ry;
  const vMaxY = vy + ry;
  // View-space camera looks down -Z, so view_z < 0 in front of camera. The
  // sphere's view-space z-extent is [vMinZ, vMaxZ] with vMinZ <= vMaxZ in raw
  // sign-order; vMinZ is the FARTHEST (most negative) edge, vMaxZ is the
  // NEAREST edge (could be positive if the sphere crosses the near plane).
  //
  // M4.5-followup: previously we did `minViewZ = max(vMinZ, -1e-5)` which
  // collapses the FAR edge of every visible light to view_z ~= 0, which the
  // log-z slice mapping then bins as slice 0. Result: every light only ever
  // wrote into slice 0/0/0 .. {gx-1}/{gy-1}/0 -- floor pixels at view_z=-3..-9
  // (slice 13..17) found 0 lights and rendered black. The clamp must guard
  // the NEAR edge (vMaxZ) instead so projectToNdc never receives a positive
  // or zero view_z, while letting the far edge flow through to its real
  // log-z slice.
  const vMinZ = vz - rz;
  const vMaxZ = vz + rz;

  const minViewZ = vMinZ;
  const maxViewZ = Math.min(vMaxZ, -1e-5);

  // If even the near edge of the sphere is behind the camera, the light
  // contributes nothing. Caller (calculateSphereClusterBounds) returns
  // min > max which the bin loop treats as cull.
  if (minViewZ > maxViewZ) {
    return {
      min: vec3.create(1, 1, -1e-5),
      max: vec3.create(-1, -1, -1e-5),
    };
  }

  let ndcMinX = Infinity;
  let ndcMaxX = -Infinity;
  let ndcMinY = Infinity;
  let ndcMaxY = -Infinity;

  const corners: Array<[number, number]> = [
    [vMinX, vMinY],
    [vMinX, vMaxY],
    [vMaxX, vMinY],
    [vMaxX, vMaxY],
  ];

  for (const zTest of [minViewZ, maxViewZ]) {
    if (zTest <= 0) {
      for (const corner of corners) {
        const sx = corner[0];
        const sy = corner[1];
        const ndc = projectToNdc(sx, sy, zTest, proj);
        ndcMinX = Math.min(ndcMinX, ndc[0]);
        ndcMaxX = Math.max(ndcMaxX, ndc[0]);
        ndcMinY = Math.min(ndcMinY, ndc[1]);
        ndcMaxY = Math.max(ndcMaxY, ndc[1]);
      }
    }
  }

  ndcMinX = Math.max(ndcMinX, -1);
  ndcMinY = Math.max(ndcMinY, -1);
  ndcMaxX = Math.min(ndcMaxX, 1);
  ndcMaxY = Math.min(ndcMaxY, 1);

  // M4.5-followup: aabb.min/max[2] now carries VIEW-SPACE z (negative), not
  // projected-NDC z. calculateSphereClusterBounds + ndcPositionToCluster +
  // viewZToZSlice all want view_z to do the log-z slice mapping; passing the
  // projected NDC z (>= 0) collapsed every light to slice 0 so cube/floor
  // fragments outside that slice received zero light.
  return {
    min: vec3.create(ndcMinX, ndcMinY, minViewZ),
    max: vec3.create(ndcMaxX, ndcMaxY, maxViewZ),
  };
}

/**
 * Project a view-space point to NDC via the perspective projection matrix.
 * Returns [ndc_x, ndc_y, ndc_z].
 */
function projectToNdc(vx: number, vy: number, vz: number, proj: Mat4): [number, number, number] {
  const p00 = proj[0] ?? 0;
  const p10 = proj[4] ?? 0;
  const p20 = proj[8] ?? 0;
  const p30 = proj[12] ?? 0;
  const p01 = proj[1] ?? 0;
  const p11 = proj[5] ?? 0;
  const p21 = proj[9] ?? 0;
  const p31 = proj[13] ?? 0;
  const p02 = proj[2] ?? 0;
  const p12 = proj[6] ?? 0;
  const p22 = proj[10] ?? 0;
  const p32 = proj[14] ?? 0;
  const p03 = proj[3] ?? 0;
  const p13 = proj[7] ?? 0;
  const p23 = proj[11] ?? 0;
  const p33 = proj[15] ?? 0;

  const cx = p00 * vx + p10 * vy + p20 * vz + p30;
  const cy = p01 * vx + p11 * vy + p21 * vz + p31;
  const cz = p02 * vx + p12 * vy + p22 * vz + p32;
  const cw = p03 * vx + p13 * vy + p23 * vz + p33;

  if (Math.abs(cw) < 1e-10) {
    return [vx < 0 ? -1 : 1, vy < 0 ? -1 : 1, cz];
  }

  const invW = 1 / cw;
  return [cx * invW, cy * invW, cz * invW];
}

// ── ndc_position_to_cluster ─────────────────────────────────────────────────

/**
 * Map an NDC point to its cluster cell index (XY + Z).
 *
 * XY: floor((ndc.xy * 0.5 + 0.5) * gridXy) clamped to [0, gridXy - 1].
 * Z: delegated to view_z_to_z_slice with the given view-space z.
 */
export function ndcPositionToCluster(
  ndc: Vec3,
  viewZ: number,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
): Uvec3 {
  const ndcX = ndc[0] ?? 0;
  const ndcY = ndc[1] ?? 0;

  let cx = Math.floor((ndcX * 0.5 + 0.5) * gridX);
  let cy = Math.floor((ndcY * 0.5 + 0.5) * gridY);

  if (cx < 0) cx = 0;
  if (cx >= gridX) cx = gridX - 1;
  if (cy < 0) cy = 0;
  if (cy >= gridY) cy = gridY - 1;

  const cz = viewZToZSlice(viewZ, gridZ, near, far);

  return { x: cx, y: cy, z: cz };
}

// ── calculate_sphere_cluster_bounds ─────────────────────────────────────────

/**
 * Convert an NDC AABB to a range of cluster cell indices.
 *
 * Computes cluster indices for AABB min and max, then clamps and
 * orders the result so `min <= max` in each axis.
 *
 * If the sphere is entirely behind the camera, returns min > max
 * in at least one axis (cull signal).
 */
export function calculateSphereClusterBounds(
  aabb: ClusterAabb,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
): ClusterBounds {
  const minZ = aabb.min[2] ?? 0;
  const maxZ = aabb.max[2] ?? 0;

  const idxMin = ndcPositionToCluster(aabb.min, minZ, gridX, gridY, gridZ, near, far);
  const idxMax = ndcPositionToCluster(aabb.max, maxZ, gridX, gridY, gridZ, near, far);

  return {
    min: {
      x: Math.min(idxMin.x, idxMax.x),
      y: Math.min(idxMin.y, idxMax.y),
      z: Math.min(idxMin.z, idxMax.z),
    },
    max: {
      x: Math.max(idxMin.x, idxMax.x),
      y: Math.max(idxMin.y, idxMax.y),
      z: Math.max(idxMin.z, idxMax.z),
    },
  };
}

// ── bin ─────────────────────────────────────────────────────────────────────

/**
 * Main entry point: assign punctual lights to cluster cells.
 *
 * Light-major loop: for each light, compute its sphere-AABB and iterate the
 * intersecting cluster cells, appending the light index to the light_index_list
 * and updating cluster_grid offsets.
 *
 * @param lights — array of { position: Vec3, range: number }
 * @param view — view matrix (column-major 16 floats)
 * @param proj — projection matrix (column-major 16 floats)
 * @param grid — cluster grid dimensions { x, y, z }
 * @param near — near plane distance
 * @param far — far plane distance
 * @param clusterGrid — caller-owned Uint32Array, length = grid.x * grid.y * grid.z * 2.
 *   Format: [offset, count] pairs. offset = start index in lightIndexList; count = number of lights.
 * @param lightIndexList — caller-owned Uint32Array for light index storage.
 * @param capacity — max entries in lightIndexList (hard cap, typically 65536).
 *
 * @returns `ok(void)` on success; `err(ClusterBinError)` with code 'index-overflow' on overflow.
 */
export function bin(
  lights: ReadonlyArray<{ readonly position: Vec3; readonly range: number }>,
  view: Mat4,
  proj: Mat4,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  near: number,
  far: number,
  clusterGrid: Uint32Array,
  lightIndexList: Uint32Array,
  capacity: number,
): Result<void, ClusterBinError> {
  const gridX = grid.x;
  const gridY = grid.y;
  const gridZ = grid.z;
  const clusterCount = gridX * gridY * gridZ;

  clusterGrid.fill(0, 0, clusterCount * 2);

  // M4.5-followup w48: switched to cluster-major writes via per-cluster lists
  // because the previous light-major append pattern produced non-contiguous
  // light index runs per cluster (light0->cluster A, light0->cluster B,
  // light1->cluster A scribbled "[A0, B0, A1, ...]" so cluster A's offset/
  // count window pointed at "[A0, B0]" — every cluster after the first only
  // ever read one correct entry). Bevy's reference implementation is
  // cluster-major (cluster_assignment.rs); this matches.
  const perCluster: number[][] = new Array(clusterCount);
  for (let i = 0; i < clusterCount; i++) perCluster[i] = [];

  let attemptedTotal = 0;

  for (let lightIdx = 0; lightIdx < lights.length; lightIdx++) {
    const light = lights[lightIdx];
    if (!light) continue;
    const radius = deriveCullingRadius(light.range, 1);

    if (radius <= 0) {
      continue;
    }

    const aabb = clusterSpaceObjectAabb(light.position, radius, view, proj);

    const bounds = calculateSphereClusterBounds(aabb, gridX, gridY, gridZ, near, far);

    if (bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z) {
      continue;
    }

    for (let cz = bounds.min.z; cz <= bounds.max.z; cz++) {
      for (let cy = bounds.min.y; cy <= bounds.max.y; cy++) {
        for (let cx = bounds.min.x; cx <= bounds.max.x; cx++) {
          const clusterIdx = cz * gridY * gridX + cy * gridX + cx;
          attemptedTotal++;
          perCluster[clusterIdx]?.push(lightIdx);
        }
      }
    }
  }

  if (attemptedTotal > capacity) {
    return err({
      code: 'index-overflow',
      expected: `writeCount <= ${capacity}`,
      hint: `light index list overflow: needed ${attemptedTotal} entries, capacity ${capacity}; reduce lights, shrink grid, or shrink ranges (overrun = ${attemptedTotal - capacity})`,
      detail: { actual: attemptedTotal, capacity },
    });
  }

  // Flatten per-cluster lists into the SoA (offset, count) + lightIndexList
  // arrays the GPU side reads. Each cluster's run is now contiguous.
  let writeCount = 0;
  for (let ci = 0; ci < clusterCount; ci++) {
    const list = perCluster[ci];
    if (!list || list.length === 0) continue;
    const base = ci * 2;
    clusterGrid[base] = writeCount;
    clusterGrid[base + 1] = list.length;
    for (let j = 0; j < list.length; j++) {
      const idx = list[j];
      if (idx !== undefined) lightIndexList[writeCount + j] = idx;
    }
    writeCount += list.length;
  }

  return ok(undefined);
}
