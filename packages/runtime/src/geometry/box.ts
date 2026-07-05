// @forgeax/engine-runtime - Procedural Box geometry (M3 / w8).
//
// Mirrors Three.js r184 BoxGeometry signature: createBoxGeometry(width, height,
// depth, widthSegments?, heightSegments?, depthSegments?) -> Result<MeshAsset, AssetError>.
// Degenerate parameters (any dim <= 0 or segment < 1) fail-fast with
// AssetError({ code: 'asset-parse-failed' }) — charter proposition 4 explicit
// failure red line (requirements §9 geometry double-semantics for
// 'asset-parse-failed').
//
// Attributes populated: position / normal / uv (Float32Array views of the
// interleaved `vertices` buffer; 8 floats per vertex). This is the AC-15
// narrowing anchor: each factory includes a
// `for (const [key] of Object.entries(attrs))` loop that TypeScript infers as
// the 6-member VertexAttributeMap key union (no `as` cast).
//
// Related: requirements §AC-06 / §AC-14 / §AC-15;
//          plan-strategy §M3 + D-P5 (6 procedural geometries lowercase keys);
//          plan-tasks.json w8 acceptanceCheck;
//          research Finding 4 (Three.js r184 BufferGeometry mental migration).

import { err, ok, type Result } from '@forgeax/engine-ecs';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  type MeshAsset,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { deriveVertexBufferLayout } from '../vertex-attribute-layout';
import { computeTangentVec4 } from './tangent';

/**
 * Floats per vertex for the procedural-geometry interleaved buffer that the
 * factory bodies fill in (position(3) + normal(3) + uv(2)). The
 * `meshFromInterleaved` helper expands this into the runtime 12-float
 * (position + normal + uv + tangent) layout consumed by the standard
 * pipeline (feat-20260518 M4 D-10).
 */
const FACTORY_FLOATS_PER_VERTEX = 8;

/**
 * Floats per vertex emitted by the factories' final MeshAsset
 * `vertices` Float32Array buffer: position(3) + normal(3) + uv(2) +
 * tangent(4) = 12. Procedural meshes feed both the standard and unlit
 * pipelines (D-10); BUILTIN_CUBE / TRIANGLE keep their 6-floats inline
 * shape (D-2 lock).
 */
export const PROCEDURAL_FLOATS_PER_VERTEX = 12;

/**
 * Build the VertexAttributeMap by binding `position` / `normal` / `uv`
 * Float32Array views over the interleaved `vertices` buffer.
 *
 * AC-15 narrowing anchor: the `for (const [key] of Object.entries(attrs))`
 * loop below sees `key` typed as `'position' | 'normal' | 'uv' | 'tangent' |
 * 'skinIndex' | 'skinWeight'` (the 6-member VertexAttributeMap key closed
 * set) — no `as` cast anywhere. Any typo (e.g. `'POSITION'`) would be a
 * tsc strict compile-time error (requirements §AC-15 narrowing evidence).
 */
function buildAttributes(vertices: Float32Array, vertexCount: number): VertexAttributeMap {
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const base = i * PROCEDURAL_FLOATS_PER_VERTEX;
    positions[i * 3 + 0] = vertices[base + 0] as number;
    positions[i * 3 + 1] = vertices[base + 1] as number;
    positions[i * 3 + 2] = vertices[base + 2] as number;
    normals[i * 3 + 0] = vertices[base + 3] as number;
    normals[i * 3 + 1] = vertices[base + 4] as number;
    normals[i * 3 + 2] = vertices[base + 5] as number;
    uvs[i * 2 + 0] = vertices[base + 6] as number;
    uvs[i * 2 + 1] = vertices[base + 7] as number;
    tangents[i * 4 + 0] = vertices[base + 8] as number;
    tangents[i * 4 + 1] = vertices[base + 9] as number;
    tangents[i * 4 + 2] = vertices[base + 10] as number;
    tangents[i * 4 + 3] = vertices[base + 11] as number;
  }
  const attrs: VertexAttributeMap = {
    position: positions,
    normal: normals,
    uv: uvs,
    tangent: tangents,
  };
  // AC-15 narrowing evidence: deriveVertexBufferLayout is the SSOT
  // for the 6-key VertexAttributeMap -> GPU vertex layout translation.
  // The call validates that attrs conforms to the closed key set.
  deriveVertexBufferLayout(attrs);
  return attrs;
}

/**
 * Shared helper: build MeshAsset POD from the factory-emitted 8-floats
 * interleaved buffer (position + normal + uv) plus index list. Computes
 * per-vertex tangent (vec4) via `computeTangentVec4` (M4 / D-2 path A) and
 * expands the buffer to the runtime 12-floats stride (position + normal +
 * uv + tangent). All six procedural factories funnel through this helper
 * so the tangent SSOT lives in `geometry/tangent.ts` (D-7).
 */
export function meshFromInterleaved(
  vertices: Float32Array,
  indices: Uint16Array | Uint32Array,
): MeshAsset {
  const vertexCount = vertices.length / FACTORY_FLOATS_PER_VERTEX;
  // Slice positions / normals / uvs out of the 8-floats interleaved
  // buffer for the tangent computation. The helper requires them in
  // tight-packed Float32Array form per attribute.
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    const base = i * FACTORY_FLOATS_PER_VERTEX;
    positions[i * 3 + 0] = vertices[base + 0] as number;
    positions[i * 3 + 1] = vertices[base + 1] as number;
    positions[i * 3 + 2] = vertices[base + 2] as number;
    normals[i * 3 + 0] = vertices[base + 3] as number;
    normals[i * 3 + 1] = vertices[base + 4] as number;
    normals[i * 3 + 2] = vertices[base + 5] as number;
    uvs[i * 2 + 0] = vertices[base + 6] as number;
    uvs[i * 2 + 1] = vertices[base + 7] as number;
  }
  const tangents = computeTangentVec4(positions, normals, uvs, indices);
  const expanded = new Float32Array(vertexCount * PROCEDURAL_FLOATS_PER_VERTEX);
  for (let i = 0; i < vertexCount; i++) {
    const dst = i * PROCEDURAL_FLOATS_PER_VERTEX;
    const src = i * FACTORY_FLOATS_PER_VERTEX;
    expanded[dst + 0] = vertices[src + 0] as number;
    expanded[dst + 1] = vertices[src + 1] as number;
    expanded[dst + 2] = vertices[src + 2] as number;
    expanded[dst + 3] = vertices[src + 3] as number;
    expanded[dst + 4] = vertices[src + 4] as number;
    expanded[dst + 5] = vertices[src + 5] as number;
    expanded[dst + 6] = vertices[src + 6] as number;
    expanded[dst + 7] = vertices[src + 7] as number;
    expanded[dst + 8] = tangents[i * 4] as number;
    expanded[dst + 9] = tangents[i * 4 + 1] as number;
    expanded[dst + 10] = tangents[i * 4 + 2] as number;
    expanded[dst + 11] = tangents[i * 4 + 3] as number;
  }
  return {
    kind: 'mesh',
    vertices: expanded,
    indices,
    attributes: buildAttributes(expanded, vertexCount),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount,
        topology: 'triangle-list',
      },
    ],
    // Procedural meshes carry their own local-space AABB: after feat-20260614
    // (D-15) `allocSharedRef` stores the payload verbatim -- there is no
    // `withMeshAabb` pass like the old `register`/`catalog` path -- so the cull
    // + pick path can only read an AABB the POD already holds.
    aabb: aabbFromPositions(positions),
  };
}

/** Local-space AABB [minX,minY,minZ,maxX,maxY,maxZ] from tight-packed xyz. */
export function aabbFromPositions(positions: Float32Array): Float32Array {
  if (positions.length < 3) {
    return Float32Array.of(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
  }
  let minX = positions[0] as number;
  let minY = positions[1] as number;
  let minZ = positions[2] as number;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

/** Shared helper: AssetError for degenerate geometry parameters. */
export function degenerate(detail: string): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected: `all dimensions > 0; segments >= 1 (${detail})`,
    hint: ASSET_ERROR_HINTS['asset-parse-failed'],
  });
}

/**
 * Build a procedural box geometry aligned with Three.js r184 BoxGeometry.
 *
 * @param width positive X-axis extent
 * @param height positive Y-axis extent
 * @param depth positive Z-axis extent
 * @param widthSegments >= 1 subdivisions along X
 * @param heightSegments >= 1 subdivisions along Y
 * @param depthSegments >= 1 subdivisions along Z
 * @returns `Result<MeshAsset, AssetError>` with attributes populated
 */
export function createBoxGeometry(
  width: number,
  height: number,
  depth: number,
  widthSegments: number = 1,
  heightSegments: number = 1,
  depthSegments: number = 1,
): Result<MeshAsset, AssetError> {
  if (width <= 0 || height <= 0 || depth <= 0) {
    return err(degenerate(`width=${width}, height=${height}, depth=${depth}`));
  }
  const ws = widthSegments | 0;
  const hs = heightSegments | 0;
  const ds = depthSegments | 0;
  if (ws < 1 || hs < 1 || ds < 1) {
    return err(degenerate(`widthSegments=${ws}, heightSegments=${hs}, depthSegments=${ds}`));
  }

  type FaceSpec = {
    readonly uAxis: 0 | 1 | 2;
    readonly vAxis: 0 | 1 | 2;
    readonly wAxis: 0 | 1 | 2;
    readonly uSign: 1 | -1;
    readonly vSign: 1 | -1;
    readonly wSign: 1 | -1;
    readonly uSegs: number;
    readonly vSegs: number;
    readonly uSize: number;
    readonly vSize: number;
    readonly wSize: number;
  };

  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;

  const faces: readonly FaceSpec[] = [
    // +X face
    {
      uAxis: 2,
      vAxis: 1,
      wAxis: 0,
      uSign: -1,
      vSign: 1,
      wSign: 1,
      uSegs: ds,
      vSegs: hs,
      uSize: depth,
      vSize: height,
      wSize: width,
    },
    // -X face
    {
      uAxis: 2,
      vAxis: 1,
      wAxis: 0,
      uSign: 1,
      vSign: 1,
      wSign: -1,
      uSegs: ds,
      vSegs: hs,
      uSize: depth,
      vSize: height,
      wSize: width,
    },
    // +Y face
    {
      uAxis: 0,
      vAxis: 2,
      wAxis: 1,
      uSign: 1,
      vSign: 1,
      wSign: 1,
      uSegs: ws,
      vSegs: ds,
      uSize: width,
      vSize: depth,
      wSize: height,
    },
    // -Y face
    {
      uAxis: 0,
      vAxis: 2,
      wAxis: 1,
      uSign: 1,
      vSign: -1,
      wSign: -1,
      uSegs: ws,
      vSegs: ds,
      uSize: width,
      vSize: depth,
      wSize: height,
    },
    // +Z face
    {
      uAxis: 0,
      vAxis: 1,
      wAxis: 2,
      uSign: 1,
      vSign: 1,
      wSign: 1,
      uSegs: ws,
      vSegs: hs,
      uSize: width,
      vSize: height,
      wSize: depth,
    },
    // -Z face
    {
      uAxis: 0,
      vAxis: 1,
      wAxis: 2,
      uSign: -1,
      vSign: 1,
      wSign: -1,
      uSegs: ws,
      vSegs: hs,
      uSize: width,
      vSize: height,
      wSize: depth,
    },
  ];

  let vertexCount = 0;
  let indexCount = 0;
  for (const f of faces) {
    vertexCount += (f.uSegs + 1) * (f.vSegs + 1);
    indexCount += f.uSegs * f.vSegs * 6;
  }

  const vertices = new Float32Array(vertexCount * FACTORY_FLOATS_PER_VERTEX);
  const indices = new Uint32Array(indexCount);
  let vIdx = 0;
  let iIdx = 0;

  const halves: readonly [number, number, number] = [hw, hh, hd];

  for (const f of faces) {
    const vStart = vIdx;
    const halfU = halves[f.uAxis] as number;
    const halfV = halves[f.vAxis] as number;
    const halfW = halves[f.wAxis] as number;
    for (let j = 0; j <= f.vSegs; j++) {
      for (let i = 0; i <= f.uSegs; i++) {
        const uCoord = ((i / f.uSegs) * f.uSize - f.uSize / 2) * f.uSign;
        const vCoord = ((j / f.vSegs) * f.vSize - f.vSize / 2) * f.vSign;
        const pos: [number, number, number] = [0, 0, 0];
        pos[f.uAxis] = (uCoord / f.uSize) * halfU * 2;
        pos[f.vAxis] = (vCoord / f.vSize) * halfV * 2;
        pos[f.wAxis] = halfW * f.wSign;
        const normal: [number, number, number] = [0, 0, 0];
        normal[f.wAxis] = f.wSign;
        const base = vIdx * FACTORY_FLOATS_PER_VERTEX;
        vertices[base + 0] = pos[0];
        vertices[base + 1] = pos[1];
        vertices[base + 2] = pos[2];
        vertices[base + 3] = normal[0];
        vertices[base + 4] = normal[1];
        vertices[base + 5] = normal[2];
        vertices[base + 6] = i / f.uSegs;
        // UV.v uses the WebGPU top-left convention (V=0 = image top).
        vertices[base + 7] = j / f.vSegs;
        vIdx++;
      }
    }
    // bug-20260519: per-face winding correction.
    //
    // The natural quad `(a, b, d) + (a, d, c)` (with a/b/c/d at quad corners
    // bottom-left / bottom-right / top-left / top-right of the (u, v) grid)
    // winds CCW around the direction `(uHat x vHat) * uSign * vSign`. We
    // want CCW around the outward normal `wSign * wHat`. The two agree iff
    //   `(uHat x vHat) . wHat * uSign * vSign * wSign == +1`.
    // The first factor is the Levi-Civita symbol of (uAxis, vAxis, wAxis):
    // +1 for cyclic permutations of (0, 1, 2), -1 for anti-cyclic. The
    // 6-face spec at the top of this function lands as:
    //   +X / -X: (Z, Y, X) anti-cyclic -> levi = -1
    //   +Y / -Y: (X, Z, Y) anti-cyclic -> levi = -1
    //   +Z / -Z: (X, Y, Z) cyclic      -> levi = +1
    // Combined with the per-face signs the product comes out to +1 for
    // ±X, ±Z (no swap needed) and -1 for ±Y (swap). The swap branch is
    // the diagonally mirrored CCW pair `(a, d, b) + (a, c, d)`.
    const isCyclic = (f.vAxis - f.uAxis + 3) % 3 === 1 && (f.wAxis - f.vAxis + 3) % 3 === 1;
    const levi = isCyclic ? 1 : -1;
    const ccwOutward = levi * f.uSign * f.vSign * f.wSign > 0;
    for (let j = 0; j < f.vSegs; j++) {
      for (let i = 0; i < f.uSegs; i++) {
        const a = vStart + j * (f.uSegs + 1) + i;
        const b = vStart + j * (f.uSegs + 1) + i + 1;
        const c = vStart + (j + 1) * (f.uSegs + 1) + i;
        const d = vStart + (j + 1) * (f.uSegs + 1) + i + 1;
        if (ccwOutward) {
          indices[iIdx++] = a;
          indices[iIdx++] = b;
          indices[iIdx++] = d;
          indices[iIdx++] = a;
          indices[iIdx++] = d;
          indices[iIdx++] = c;
        } else {
          indices[iIdx++] = a;
          indices[iIdx++] = d;
          indices[iIdx++] = b;
          indices[iIdx++] = a;
          indices[iIdx++] = c;
          indices[iIdx++] = d;
        }
      }
    }
  }

  return ok(meshFromInterleaved(vertices, indices));
}
