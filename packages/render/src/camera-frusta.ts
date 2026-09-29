import { frustum, mat4 } from '@forgeax/engine-math';
import type { CameraSnapshot } from './render-contract';

/**
 * Build the camera frusta consumed by Render's CPU culling paths.
 *
 * The empty plane sentinel is intentional: invalid perspective dimensions and
 * inverted near/far ranges remain conservative always-visible cameras. Keep
 * the projection, view inversion, and multiplication order aligned with the
 * record stage's camera matrices.
 */
export function buildCameraFrusta(cameras: readonly CameraSnapshot[]): readonly Float32Array[] {
  const planes: Float32Array[] = [];
  for (const camera of cameras) {
    if (
      (camera.projection === 'perspective' && (camera.fov <= 0 || camera.aspect <= 0)) ||
      camera.near >= camera.far
    ) {
      planes.push(new Float32Array(0));
      continue;
    }
    const projection = mat4.create();
    if (camera.projection === 'orthographic') {
      mat4.orthographicReverseZ(
        projection,
        camera.orthoLeft,
        camera.orthoRight,
        camera.orthoTop,
        camera.orthoBottom,
        camera.near,
        camera.far,
      );
    } else {
      mat4.perspectiveReverseZ(projection, camera.fov, camera.aspect, camera.near, camera.far);
    }
    const view = mat4.create();
    mat4.invert(view, camera.world);
    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, projection, view);
    const cameraPlanes = frustum.create();
    frustum.fromViewProjection(cameraPlanes, viewProjection);
    planes.push(cameraPlanes);
  }
  return planes;
}
