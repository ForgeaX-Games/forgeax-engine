// @forgeax/engine-state -- statePlugin factory (M2 / w7, plan-strategy D-9 / D-10).
//
// Wraps the existing void registerStatesPlugin(world) into the unified Plugin
// shape: build(world) registers the per-token Resources + the transitionStates
// system, then returns ok(undefined) (D-10: the register function keeps its
// void signature; the plugin layer is the only place the void->Result wrap
// happens).
//
// Plugin type comes from @forgeax/engine-plugin (L1.5); ok from
// @forgeax/engine-ecs (same layer as registerStatesPlugin).
//
// charter awareness:
//   P4 consistent abstraction: statePlugin shares the same Plugin shape as
//       transform / physics / audio -- one mental model covers every wiring.

import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

import { registerStatesPlugin } from './register-plugin';

/**
 * statePlugin -- registers the state-machine systems + per-token Resources.
 *
 * Equivalent to the create-app.ts call `registerStatesPlugin(world)`: inserts
 * State / NextState / PreviousState Resources for every registered token,
 * pre-registers ScopedTo components, and registers the transitionStates system
 * (anchored after 'input-frame-start-scan', before 'propagateTransforms').
 */
export function statePlugin(): Plugin {
  return {
    name: 'state',
    build(world) {
      registerStatesPlugin(world);
      return ok(undefined);
    },
  };
}
