// @forgeax/engine-state -- public barrel (feat-20260616-engine-state-and-state-scoped-entities M1)
//
// Single-entry surface: defineState + StateToken + Resources + errors.
// registerStatesPlugin / setNextState / transition system deferred to M2/M3.

export { inState } from './conditions';
export type {
  StateToken,
  StateTokenName,
  StateTokenVariant,
} from './define-state';
export {
  defineState,
  getRegisteredTokens,
} from './define-state';
export type {
  InvalidVariantDetail,
  StateAlreadyDefinedDetail,
  StateDefaultRequiredDetail,
  StateError,
  StateErrorCode,
  StateErrorDetail,
  StateNotRegisteredDetail,
} from './errors';
export type {
  StateCallback,
  UnsubscribeHandle,
} from './on-enter-on-exit';
export {
  addOnEnter,
  addOnExit,
  getCallbacks,
  OnEnter,
  OnExit,
} from './on-enter-on-exit';
export { statePlugin } from './plugin-factory';
export { registerStatesPlugin, StateSet } from './register-plugin';
export {
  nextStateResourceKey,
  previousStateResourceKey,
  stateResourceKey,
} from './resources';
export {
  countScopedEntitiesByVariant,
  despawnOnEnter,
  despawnOnExit,
} from './scoped-component';
export {
  getPreviousState,
  getState,
  setNextState,
  setNextStateForce,
} from './set-next-state';
