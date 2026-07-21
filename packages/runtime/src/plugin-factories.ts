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

import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

import { registerEvaluateAnimationGraph } from './animation/evaluate-animation-graph';
import {
  ANIMATION_ASSET_RESOLVER_KEY,
  createAnimationAssetResolver,
  registerAdvanceAnimationPlayer,
  registerPropagateTransforms,
} from './createRenderer';

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
 * animationPlugin -- inserts the AnimationAssetResolver resource + registers
 * advanceAnimationPlayer.
 *
 * SSOT (like physicsPlugin/statePlugin): the plugin OWNS its system's resource.
 * advanceAnimationPlayer declares `resources: [ANIMATION_ASSET_RESOLVER_KEY]`
 * UNCONDITIONALLY, so the resolver must exist before the first world.update(1 / 60).unwrap().
 * By minting + inserting it here, BOTH createApp forms are correct for free —
 * the canvas form no longer hand-inserts it (was create-app.ts, the sole writer)
 * and the assemble form (host-owned world, e.g. the editor ▶ Play fork) gets it
 * without the host having to remember. That divergence — canvas inserted, assemble
 * did not — is exactly what crashed editor ▶ Play with "Required resource
 * 'AnimationAssetResolver' not found".
 *
 * The resolver is a pure handle→AnimationClip lookup over the per-World
 * SharedRefStore (createAnimationAssetResolver ignores its `assets` arg — the
 * AssetRegistry holds no handle map since feat-20260614 M8), so `null` is the
 * honest argument here; no registry dependency, no insertion-order coupling.
 *
 * feat-20260713 M3 / w26 (plan D-2, AC-09): the plugin also registers
 * evaluateAnimationGraph (the graph→N-slot seam). It declares
 * `before: [advanceAnimationPlayer]`, so listing the default animation capability
 * puts DAG evaluation on the default path — no opt-in. Entities without a graph
 * (graph == 0) flow through the untouched direct-write path.
 */
export function animationPlugin(): Plugin {
  return {
    name: 'animation',
    build(world) {
      if (!world.hasResource(ANIMATION_ASSET_RESOLVER_KEY)) {
        world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, createAnimationAssetResolver(null));
      }
      registerEvaluateAnimationGraph(world);
      registerAdvanceAnimationPlayer(world);
      return ok(undefined);
    },
  };
}
