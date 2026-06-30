// @forgeax/engine-state -- registerStatesPlugin (M2 / m2w2, M3 / m3w4)
//
// Idempotent plugin that inserts per-token Resources (State / NextState /
// PreviousState), pre-registers ScopedTo components, and registers the
// transitionStatesSystem in the ECS schedule. Called automatically by
// createApp in both canvas and assemble forms.
//
// M3 / m3w4: stub replaced with transitionStatesSystem from transition-system.ts.
//
// Decision anchors:
// - requirements F-9: idempotent, canvas + assemble dual-form auto-wire
// - plan-strategy D-6: schedule anchors 'input-frame-start-scan' -> 'transitionStates' -> 'propagateTransforms'
// - plan-strategy D-4: insertResource initial values from token.defaultValue

import { defineSystem, type SystemHandle, type World } from '@forgeax/engine-ecs';
import { getRegisteredTokens } from './define-state';
import { nextStateResourceKey, previousStateResourceKey, stateResourceKey } from './resources';
import { registerScopedComponents } from './scoped-component';
import { transitionStatesSystem } from './transition-system';

/** Schedule anchor: system name for the input frame-start scan (registered by {@link @forgeax/engine-input}). */
const FRAME_START_SCAN_SYSTEM_NAME = 'input-frame-start-scan' as const;

/** Schedule anchor: system name for the transform-propagation system (registered by {@link @forgeax/engine-runtime}). */
const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;

const TRANSITION_STATES_SYSTEM_NAME = 'transitionStates';

/**
 * The `transitionStates` system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no closure, no
 * placeholder. The fn reads `world` from its first parameter (the M1
 * world-first signature) and delegates to {@link transitionStatesSystem}.
 * Anchored `after: ['input-frame-start-scan']`, `before: ['propagateTransforms']`
 * and labelled `'state'` (spec §6.2 label-anchor map).
 */
export const TransitionStates: SystemHandle<readonly []> = defineSystem({
  name: TRANSITION_STATES_SYSTEM_NAME,
  queries: [],
  labels: ['state'],
  after: [FRAME_START_SCAN_SYSTEM_NAME],
  before: [PROPAGATE_TRANSFORMS_SYSTEM],
  fn: (world) => {
    transitionStatesSystem(world);
  },
});

/**
 * Register the state-machine plugin on a {@link World}.
 *
 * Side effects:
 * 1. Pre-registers `__scopedTo__<name>` components for all known tokens.
 * 2. For each globally registered {@link StateToken}: inserts three Resources
 *    ({@link State} = defaultValue index, {@link NextState} = undefined,
 *    {@link PreviousState} = defaultValue index).
 * 3. Registers the {@link TransitionStates} system in the schedule.
 *
 * Re-registering the {@link TransitionStates} token overwrites the same name
 * slot (M2: defineSystem token is fixed, so no findSystem dedup guard is
 * needed). Resource inserts are idempotent overwrites to each token's default.
 *
 * Called automatically by {@link createApp} in both canvas and assemble
 * forms; manual callers must invoke it before {@link setNextState}.
 */
export function registerStatesPlugin(world: World): void {
  // Pre-register ScopedTo components for all known tokens.
  registerScopedComponents();

  // Insert per-token Resources.
  for (const token of getRegisteredTokens().values()) {
    const defaultValueIdx = token.nameToIdx.get(token.defaultValue);
    if (defaultValueIdx === undefined) {
      continue;
    }

    world.insertResource(stateResourceKey(token), defaultValueIdx);
    world.insertResource(
      nextStateResourceKey(token),
      undefined as { value: number; force: boolean } | undefined,
    );
    world.insertResource(previousStateResourceKey(token), defaultValueIdx);
  }

  // Register the transition system.
  world.addSystem(TransitionStates);
}
