import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { SceneEntityRef } from '@forgeax/engine-types';
import { sceneEntity, sceneEntityAddressFromKey } from './binding.js';
import { type SceneInstanceStatePayload, sceneWorldState } from './state.js';

/**
 * @internal Reverse keyed-binding lookup for diagnostics. Prefers the outermost
 * instance (no parent `instanceKey`), whose address spans nested instances.
 * Returns undefined for entities that no SceneInstance binds.
 */
export function worldSceneEntityRefOf(
  world: World,
  entity: EntityHandle,
): SceneEntityRef | undefined {
  let nested: SceneEntityRef | undefined;
  for (const payload of sceneWorldState(world).statePayloads.values()) {
    const state = payload as Partial<SceneInstanceStatePayload>;
    if (state.bindings === undefined) continue;
    for (const [key, bound] of state.bindings) {
      if (bound !== entity) continue;
      const ref = sceneEntity(state.sceneSourceKey ?? '', sceneEntityAddressFromKey(key));
      if (state.instanceKey === undefined) return ref;
      nested ??= ref;
    }
  }
  return nested;
}
