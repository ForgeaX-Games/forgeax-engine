// @forgeax/engine-state -- setNextState / getState / getPreviousState (M2 / m2w4)
//
// Free functions that read and write per-token Resource slots. All return
// Result<T, StateError> (never throw for AI-user call sites per AGENTS.md
// Error model).
//
// Decision anchors:
// - requirements C-3: setNextState returns Result.err, not throw
// - requirements C-4: free functions, not world.x methods
// - requirements F-5/F-6: State / NextState / PreviousState as Resources
// - plan-strategy D-4: State stores variant index (u32), decoded via token.variants

import type { World } from '@forgeax/engine-ecs';
import type { StateToken, StateTokenVariant } from './define-state';
import type { StateError } from './errors';
import { invalidVariant, stateNotRegistered } from './errors';
import { nextStateResourceKey, previousStateResourceKey, stateResourceKey } from './resources';

interface NextStatePayload {
  value: number;
  force: boolean;
}

function errWrap(err: StateError): { ok: false; error: StateError } {
  return { ok: false, error: err };
}

/**
 * Request a state transition for `token` to `variant` at the next frame.
 *
 * `variant` is narrowed to the token's variant union: a misspelled variant is
 * a compile-time error (`StateTokenVariant<T>`), not just a runtime
 * `invalid-variant` Result.
 */
export function setNextState<T extends StateToken>(
  world: World,
  token: T,
  variant: StateTokenVariant<T>,
): { ok: true; value: undefined } | { ok: false; error: StateError } {
  return _runCheckAndWrite(world, token, variant, false);
}

/**
 * Like {@link setNextState} but with `force=true`.
 */
export function setNextStateForce<T extends StateToken>(
  world: World,
  token: T,
  variant: StateTokenVariant<T>,
): { ok: true; value: undefined } | { ok: false; error: StateError } {
  return _runCheckAndWrite(world, token, variant, true);
}

function _runCheckAndWrite(world: World, token: StateToken, variant: string, force: boolean) {
  const nsKey = nextStateResourceKey(token);
  if (!world.hasResource(nsKey)) {
    return errWrap(stateNotRegistered(token.name));
  }

  const idx = token.nameToIdx.get(variant as never);
  if (idx === undefined) {
    return errWrap(invalidVariant(token.name, variant, token.variants));
  }

  world.insertResource<NextStatePayload>(nsKey, { value: idx, force });
  return { ok: true as const, value: undefined };
}

/**
 * Read the current state value for `token`.
 */
export function getState(
  world: World,
  token: StateToken,
): { ok: true; value: string } | { ok: false; error: StateError } {
  const key = stateResourceKey(token);
  if (!world.hasResource(key)) {
    return errWrap(stateNotRegistered(token.name));
  }
  const idx = world.getResource<number>(key);
  const variant = token.variants[idx];
  if (variant === undefined) {
    return errWrap(invalidVariant(token.name, String(idx), token.variants));
  }
  return { ok: true as const, value: variant };
}

/**
 * Read the previous-frame state value for `token`.
 */
export function getPreviousState(
  world: World,
  token: StateToken,
): { ok: true; value: string } | { ok: false; error: StateError } {
  const key = previousStateResourceKey(token);
  if (!world.hasResource(key)) {
    return errWrap(stateNotRegistered(token.name));
  }
  const idx = world.getResource<number>(key);
  const variant = token.variants[idx];
  if (variant === undefined) {
    return errWrap(invalidVariant(token.name, String(idx), token.variants));
  }
  return { ok: true as const, value: variant };
}
