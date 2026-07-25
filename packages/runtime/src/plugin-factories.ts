// @forgeax/engine-runtime -- plugin factories (M2 / w6, plan-strategy D-9 / D-4 / D-10).
//
// transformPlugin and animationPlugin wrap existing registration functions into
// the unified Plugin shape. Each build(world) calls its registration function
// and signals success with ok(undefined).
//
// Plugin / PluginError types come from @forgeax/engine-plugin (L1.5 thin
// protocol package); ok comes from @forgeax/engine-ecs (same layer as the
// register functions).
//
// charter awareness:
//   P4 consistent abstraction: transform / animation / time share one Plugin
//       shape -- the AI user learns it once and it covers every capability.

import { animationPlugin as extractedAnimationPlugin } from '@forgeax/engine-animation';
import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

import { registerPropagateTransforms } from '@forgeax/engine-scene';

/**
 * transformPlugin -- registers propagateTransforms (the sole writer of the
 * derived Transform.world mat4 column).
 *
 * Equivalent to the create-app.ts canvas-form call
 * `registerPropagateTransforms(world)`.
 */
export function transformPlugin(): Plugin {
  return {
    name: 'transform',
    build(world) {
      registerPropagateTransforms(world);
      return ok(undefined);
    },
  };
}

/**
 * animationPlugin -- composes graph evaluation and clip playback from the
 * renderer-independent animation package. Asset handles resolve against the
 * running World; app hosts do not provide animation-specific resources.
 *
 * feat-20260713 M3 / w26 (plan D-2, AC-09): the plugin also registers
 * evaluateAnimationGraph (the graph→N-slot seam). It declares
 * `before: [advanceAnimationPlayer]`, so listing the default animation capability
 * puts DAG evaluation on the default path — no opt-in. Entities without a graph
 * (graph == 0) flow through the untouched direct-write path.
 */
export function animationPlugin(): Plugin {
  return extractedAnimationPlugin();
}
