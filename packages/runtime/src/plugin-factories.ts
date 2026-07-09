// @forgeax/engine-runtime -- plugin factories (M2 / w6, plan-strategy D-9 / D-4 / D-10).
//
// transformPlugin / animationPlugin / timePlugin wrap the existing void
// register functions into the unified Plugin shape. Each build(world) calls
// the register function (if any) and signals success with ok(undefined)
// (D-10: register functions keep their void signature; the plugin layer is the
// only place the void->Result wrap happens).
//
// timePlugin is a no-op placeholder (D-4 / R5): Time is written every frame by
// the frame-loop, so there is no register function to call. The plugin still
// exists so the inspector lists 'time' and a same-name duplicate-plugin is
// detected (it occupies a slot in the merged Map).
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
 * UNCONDITIONALLY, so the resolver must exist before the first world.update().
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
 */
export function animationPlugin(): Plugin {
  return {
    name: 'animation',
    build(world) {
      if (!world.hasResource(ANIMATION_ASSET_RESOLVER_KEY)) {
        world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, createAnimationAssetResolver(null));
      }
      registerAdvanceAnimationPlayer(world);
      return ok(undefined);
    },
  };
}

/**
 * timePlugin -- no-op placeholder (D-4 / R5).
 *
 * Time is written every frame by the frame-loop, not by a registered system,
 * so build has nothing to register. The plugin exists only to occupy the
 * 'time' name in the default set (inspector enumeration + duplicate-plugin
 * detection).
 */
export function timePlugin(): Plugin {
  return {
    name: 'time',
    build() {
      return ok(undefined);
    },
  };
}
