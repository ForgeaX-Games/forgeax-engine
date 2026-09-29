import { mat4 } from '@forgeax/engine-math';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import type { CameraSnapshot } from './render-contract';
import type { RenderSceneBounds } from './scene/render-scene-types';

const identityWorld = mat4.identity(mat4.create());

/** Project a retained world-space union without applying the entity transform twice. */
export function buildWorldOcclusionProxyVertices(
  bounds: RenderSceneBounds,
  camera: CameraSnapshot,
): Float32Array {
  return buildOcclusionProxyVertices([...bounds.min, ...bounds.max], identityWorld, camera);
}

/** Build the camera-facing proxy geometry used by GPU occlusion queries. */
export function buildOcclusionProxyVertices(
  aabb: ArrayLike<number>,
  world: ArrayLike<number>,
  camera: CameraSnapshot,
): Float32Array {
  const view = computeViewMatrix(camera);
  const projection = computeProjectionMatrix(camera);
  const viewProjection = mat4.create();
  mat4.multiply(viewProjection, projection, view);
  const corners = [
    [aabb[0] ?? 0, aabb[1] ?? 0, aabb[2] ?? 0],
    [aabb[3] ?? 0, aabb[1] ?? 0, aabb[2] ?? 0],
    [aabb[3] ?? 0, aabb[4] ?? 0, aabb[2] ?? 0],
    [aabb[0] ?? 0, aabb[4] ?? 0, aabb[2] ?? 0],
    [aabb[0] ?? 0, aabb[1] ?? 0, aabb[5] ?? 0],
    [aabb[3] ?? 0, aabb[1] ?? 0, aabb[5] ?? 0],
    [aabb[3] ?? 0, aabb[4] ?? 0, aabb[5] ?? 0],
    [aabb[0] ?? 0, aabb[4] ?? 0, aabb[5] ?? 0],
  ];
  const triangles = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5,
    6, 1, 6, 2,
  ];
  const output = new Float32Array(triangles.length * 4);
  for (let index = 0; index < triangles.length; index += 1) {
    const corner = corners[triangles[index] ?? 0] ?? [0, 0, 0];
    const cx = corner[0] ?? 0;
    const cy = corner[1] ?? 0;
    const cz = corner[2] ?? 0;
    const x = (world[0] ?? 0) * cx + (world[4] ?? 0) * cy + (world[8] ?? 0) * cz + (world[12] ?? 0);
    const y = (world[1] ?? 0) * cx + (world[5] ?? 0) * cy + (world[9] ?? 0) * cz + (world[13] ?? 0);
    const z =
      (world[2] ?? 0) * cx + (world[6] ?? 0) * cy + (world[10] ?? 0) * cz + (world[14] ?? 0);
    const w =
      (world[3] ?? 0) * cx + (world[7] ?? 0) * cy + (world[11] ?? 0) * cz + (world[15] ?? 1);
    const base = index * 4;
    output[base] =
      (viewProjection[0] ?? 0) * x +
      (viewProjection[4] ?? 0) * y +
      (viewProjection[8] ?? 0) * z +
      (viewProjection[12] ?? 0) * w;
    output[base + 1] =
      (viewProjection[1] ?? 0) * x +
      (viewProjection[5] ?? 0) * y +
      (viewProjection[9] ?? 0) * z +
      (viewProjection[13] ?? 0) * w;
    output[base + 2] =
      (viewProjection[2] ?? 0) * x +
      (viewProjection[6] ?? 0) * y +
      (viewProjection[10] ?? 0) * z +
      (viewProjection[14] ?? 0) * w;
    output[base + 3] =
      (viewProjection[3] ?? 0) * x +
      (viewProjection[7] ?? 0) * y +
      (viewProjection[11] ?? 0) * z +
      (viewProjection[15] ?? 0) * w;
  }
  return output;
}
