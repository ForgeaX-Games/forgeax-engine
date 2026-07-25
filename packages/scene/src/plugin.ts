import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { registerPropagateTransforms } from './systems/propagate-transforms';

export function scenePlugin(): Plugin {
  return {
    name: 'scene',
    build(world) {
      registerPropagateTransforms(world);
      return ok(undefined);
    },
  };
}
