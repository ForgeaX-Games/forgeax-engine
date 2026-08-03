/**
 * Animation graphs, players, and stable Transform targets.
 *
 * AI consumers should collect explicit entities, call
 * {@link bindAnimationTargets} once, then configure the existing
 * {@link AnimationPlayer} directly or through {@link defineAnimationGraph}.
 * Binding failures expose stable `code`, `hint`, and `detail` fields.
 *
 * @see ../README.md
 */
export type {
  AnimationDiagnostic,
  AnimationDiagnosticCode,
  AnimationDiagnosticDetail,
} from './animation-diagnostic';
export { AnimationPlayer } from './animation-player';
/** Stable target identity, explicit ownership, and atomic batch binding. */
export * from './animation-target';
export * from './errors';
/** Build the existing graph-to-player slot path; this is not an animation FSM. */
export * from './graph/define-animation-graph';
export * from './graph/describe-animation-graph';
export * from './graph/serialize-animation-graph';
export * from './player-errors';
export { animationPlugin } from './plugin';
export {
  AnimationAssetError,
  type AnimationAssetErrorCode,
  type AnimationAssetErrorDetail,
  resolveAnimationAsset,
} from './resolve-animation-asset';
export {
  _resetAnimationWarnsForTests,
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  AdvanceAnimationPlayer,
  AnimationSet,
  advanceAnimationPlayer,
  registerAdvanceAnimationPlayer,
} from './systems/advance-animation-player';
export {
  EvaluateAnimationGraph,
  evaluateAnimationGraph,
  registerEvaluateAnimationGraph,
} from './systems/evaluate-animation-graph';
/** Derive or validate the canonical 32-lowercase-hex animation target wire. */
export * from './target-id';
