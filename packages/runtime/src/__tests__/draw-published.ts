import type { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';

/** Drive the production attach -> update -> draw contract in direct-render tests. */
export function drawPublished(renderer: Renderer, world: World): ReturnType<Renderer['draw']> {
  const attached = renderer.attachWorld(world);
  if (!attached.ok) throw attached.error;
  world.update(1 / 60).unwrap();
  return renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
}
