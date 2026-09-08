import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf } from '../../index';

/**
 * Scene-owned malformed-edge fixture. The public relationship write accepts
 * stale handles as data; the projection then owns the liveness diagnostic.
 * Keeping this fixture on `world.set` avoids a private ECS graph seam.
 */
export function setMalformedParentEdge(
  world: World,
  child: EntityHandle,
  parent: EntityHandle,
): void {
  world.set(child, ChildOf, { parent }).unwrap();
}
