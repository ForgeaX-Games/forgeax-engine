// @forgeax/engine-runtime - per-vertex tangent (vec4) helper (M4 / w20).
//
// Implements the path A formula (LearnOpenGL section 5.4 + glTF 2.0 vec4
// shape) for procedural geometry: per-triangle UV-derivative tangent ->
// face-area-weighted average -> Gram-Schmidt re-orthogonalisation against
// the supplied per-vertex normal -> handedness sign(det(deltaUV)) packed
// into the .w channel.
//
// Output shape: Float32Array (vertexCount * 4) where each vertex is
// [tx, ty, tz, w] with `.w` in {+1, -1}. The .w sign is forward-compatible
// with glTF 2.0 spec / MikkTSpace baker (`B = cross(N, T.xyz) * T.w`),
// satisfying feat-20260518 risk R-4 mitigation (path A vec4 -> path B
// shader consumption is a no-op switch).
//
// Plan-strategy anchors: section 2 D-2 (path A); D-7 (single-file helper to
// avoid 30-line per-geometry re-implementation -- SSOT #1 + DRY #2).
// Knowledge-base anchor: .forgeax-harness/knowledge-base/wiki/normal-mapping-and-tbn.md
// section 2 (math skeleton) and section 2.2 (per-vertex average +
// handedness). Risk anchor: R-4 (vec4 + .w forward compatibility).
//
// Pure function, zero deps. Indices may be Uint16Array, Uint32Array, or
// undefined (sequential 0..vertexCount-1 -- triangle list). Degenerate
// triangles (zero area UV; det ~ 0) are skipped from the accumulation;
// vertices touched only by degenerate triangles fall back to a stable
// frame: tangent perpendicular to the supplied normal with .w = +1.

const EPSILON = 1e-8;

/**
 * Compute per-vertex tangent (vec4) for a procedural mesh using path A
 * (UV-derivative + face-area-weighted average + Gram-Schmidt + handedness).
 *
 * @param positions Float32Array, vertexCount * 3 (xyz interleaved).
 * @param normals Float32Array, vertexCount * 3 (xyz interleaved); must be
 *   pre-normalised by the caller (procedural factories already produce
 *   unit-length normals at vertex emit time).
 * @param uvs Float32Array, vertexCount * 2 (uv interleaved).
 * @param indices optional Uint16Array | Uint32Array triangle list; when
 *   undefined, sequential triangulation 0,1,2,3,4,5,... is assumed.
 * @returns Float32Array (vertexCount * 4) with .xyz tangent + .w
 *   handedness sign in {+1, -1}.
 *
 * @remarks
 * Path A formula (per triangle):
 * ```
 * dP1 = p2 - p1; dP2 = p3 - p1
 * dUV1 = uv2 - uv1; dUV2 = uv3 - uv1
 * det = dUV1.u * dUV2.v - dUV2.u * dUV1.v
 * T_face = (dUV2.v * dP1 - dUV1.v * dP2) / det
 * sign = det >= 0 ? +1 : -1
 * ```
 * Per-vertex aggregation: accumulate `T_face * faceArea` into the three
 * vertices of the triangle; accumulate `sign` (the dominant sign per
 * vertex wins). After accumulation: Gram-Schmidt against the supplied
 * normal `T' = normalize(T - dot(T, N) * N)`; repack as vec4 with the
 * dominant handedness sign.
 */
export function computeTangentVec4(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices?: Uint16Array | Uint32Array,
): Float32Array {
  const vertexCount = positions.length / 3;
  if (normals.length !== vertexCount * 3) {
    throw new Error(
      `computeTangentVec4: normals.length=${normals.length} mismatched positions vertexCount=${vertexCount}`,
    );
  }
  if (uvs.length !== vertexCount * 2) {
    throw new Error(
      `computeTangentVec4: uvs.length=${uvs.length} mismatched positions vertexCount=${vertexCount}`,
    );
  }

  // Working buffers: per-vertex accumulated tangent + accumulated handedness
  // signed weight (sum of (face area * sign(det))). The dominant sign of
  // the running sum is the per-vertex .w handedness.
  const accumT = new Float32Array(vertexCount * 3);
  const accumSign = new Float32Array(vertexCount);

  const triangleCount = indices !== undefined ? indices.length / 3 : vertexCount / 3;

  for (let tri = 0; tri < triangleCount; tri++) {
    const i0 = indices !== undefined ? (indices[tri * 3] ?? 0) : tri * 3;
    const i1 = indices !== undefined ? (indices[tri * 3 + 1] ?? 0) : tri * 3 + 1;
    const i2 = indices !== undefined ? (indices[tri * 3 + 2] ?? 0) : tri * 3 + 2;

    const p0x = positions[i0 * 3] ?? 0;
    const p0y = positions[i0 * 3 + 1] ?? 0;
    const p0z = positions[i0 * 3 + 2] ?? 0;
    const p1x = positions[i1 * 3] ?? 0;
    const p1y = positions[i1 * 3 + 1] ?? 0;
    const p1z = positions[i1 * 3 + 2] ?? 0;
    const p2x = positions[i2 * 3] ?? 0;
    const p2y = positions[i2 * 3 + 1] ?? 0;
    const p2z = positions[i2 * 3 + 2] ?? 0;

    const u0 = uvs[i0 * 2] ?? 0;
    const v0 = uvs[i0 * 2 + 1] ?? 0;
    const u1 = uvs[i1 * 2] ?? 0;
    const v1 = uvs[i1 * 2 + 1] ?? 0;
    const u2 = uvs[i2 * 2] ?? 0;
    const v2 = uvs[i2 * 2 + 1] ?? 0;

    const dP1x = p1x - p0x;
    const dP1y = p1y - p0y;
    const dP1z = p1z - p0z;
    const dP2x = p2x - p0x;
    const dP2y = p2y - p0y;
    const dP2z = p2z - p0z;

    const dU1 = u1 - u0;
    const dV1 = v1 - v0;
    const dU2 = u2 - u0;
    const dV2 = v2 - v0;

    const det = dU1 * dV2 - dU2 * dV1;
    if (Math.abs(det) < EPSILON) {
      // degenerate UV (collinear / zero-area in UV space); skip
      continue;
    }
    const invDet = 1 / det;
    const tx = invDet * (dV2 * dP1x - dV1 * dP2x);
    const ty = invDet * (dV2 * dP1y - dV1 * dP2y);
    const tz = invDet * (dV2 * dP1z - dV1 * dP2z);

    // Face area (cross product magnitude / 2). Used as accumulation weight.
    const cx = dP1y * dP2z - dP1z * dP2y;
    const cy = dP1z * dP2x - dP1x * dP2z;
    const cz = dP1x * dP2y - dP1y * dP2x;
    const faceArea = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (faceArea < EPSILON) continue;

    const signDet = det >= 0 ? 1 : -1;
    const signedWeight = faceArea * signDet;

    for (const vi of [i0, i1, i2]) {
      accumT[vi * 3] = (accumT[vi * 3] ?? 0) + tx * faceArea;
      accumT[vi * 3 + 1] = (accumT[vi * 3 + 1] ?? 0) + ty * faceArea;
      accumT[vi * 3 + 2] = (accumT[vi * 3 + 2] ?? 0) + tz * faceArea;
      accumSign[vi] = (accumSign[vi] ?? 0) + signedWeight;
    }
  }

  const out = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    let tx = accumT[v * 3] ?? 0;
    let ty = accumT[v * 3 + 1] ?? 0;
    let tz = accumT[v * 3 + 2] ?? 0;
    const nx = normals[v * 3] ?? 0;
    const ny = normals[v * 3 + 1] ?? 0;
    const nz = normals[v * 3 + 2] ?? 0;

    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tLen < EPSILON) {
      // Fallback: pick any direction perpendicular to N. Use the axis
      // with the smallest |normal component| to maximise numerical
      // stability of the cross product.
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      let rx = 1;
      let ry = 0;
      let rz = 0;
      if (ax <= ay && ax <= az) {
        rx = 1;
        ry = 0;
        rz = 0;
      } else if (ay <= ax && ay <= az) {
        rx = 0;
        ry = 1;
        rz = 0;
      } else {
        rx = 0;
        ry = 0;
        rz = 1;
      }
      // T = normalize(cross(N, R))
      tx = ny * rz - nz * ry;
      ty = nz * rx - nx * rz;
      tz = nx * ry - ny * rx;
      const fLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= fLen;
      ty /= fLen;
      tz /= fLen;
    } else {
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;
    }

    // Gram-Schmidt: T' = normalize(T - dot(T, N) * N)
    const dotTN = tx * nx + ty * ny + tz * nz;
    let gx = tx - dotTN * nx;
    let gy = ty - dotTN * ny;
    let gz = tz - dotTN * nz;
    const gLen = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gLen < EPSILON) {
      // tangent collinear with normal after accumulation; reuse fallback
      // basis. Pick perpendicular via the smallest-axis trick again.
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      let rx = 1;
      let ry = 0;
      let rz = 0;
      if (ax <= ay && ax <= az) {
        rx = 1;
        ry = 0;
        rz = 0;
      } else if (ay <= ax && ay <= az) {
        rx = 0;
        ry = 1;
        rz = 0;
      } else {
        rx = 0;
        ry = 0;
        rz = 1;
      }
      gx = ny * rz - nz * ry;
      gy = nz * rx - nx * rz;
      gz = nx * ry - ny * rx;
      const fLen = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      gx /= fLen;
      gy /= fLen;
      gz /= fLen;
    } else {
      gx /= gLen;
      gy /= gLen;
      gz /= gLen;
    }

    const accSign = accumSign[v] ?? 0;
    const w = accSign >= 0 ? 1 : -1;

    out[v * 4] = gx;
    out[v * 4 + 1] = gy;
    out[v * 4 + 2] = gz;
    out[v * 4 + 3] = w;
  }

  return out;
}
