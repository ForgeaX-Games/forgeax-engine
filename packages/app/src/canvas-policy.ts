import type { World } from '@forgeax/engine-ecs';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera } from '@forgeax/engine-render';

/** Keep host-owned perspective camera aspect policy in one execution-tier seam. */
export function syncCameraAspect(world: World, canvasW: number, canvasH: number): void {
  if (canvasW <= 0 || canvasH <= 0) return;
  const aspect = canvasW / canvasH;
  const query = world.query({ with: [Camera] }).unwrap();
  for (const row of query) {
    const camera = world.get(row.entity, Camera);
    if (!camera.ok) continue;
    if (camera.value.autoAspect !== true) continue;
    if (camera.value.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
    world.set(row.entity, Camera, { aspect });
  }
}
