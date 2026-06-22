// @forgeax/engine-state -- error model SSOT (feat-20260616-engine-state-and-state-scoped-entities M1 / m1w4)
//
// Closed union StateErrorCode (4 members), discriminated detail union,
// and structured StateError carrying .code / .expected / .hint / .detail.
//
// Decision anchors:
// - plan-strategy D-4: 4-code order-locked closed union + discriminated detail
// - requirements sec 2.7: error code union, defineState throws (programmer error),
//   setNextState / getState return Result.err (runtime AI user calls)
// - AGENTS.md Error model: structured errors with .expected / .hint / .detail,
//   never throw for runtime paths; exhaustive switch without default

/**
 * Closed {@link StateErrorCode} union -- 4 members, order-locked.
 * Exhaustive `switch (err.code)` needs no default fallback.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'state-already-defined'` | `defineState()` called with a name already registered |
 * | `'state-not-registered'` | `setNextState()` / `getState()` called before `registerStatesPlugin()` |
 * | `'invalid-variant'` | `setNextState()` called with a variant string not in the token's variants tuple |
 * | `'state-default-required'` | `defineState()` called with empty variants array |
 */
export type StateErrorCode =
  | 'state-already-defined'
  | 'state-not-registered'
  | 'invalid-variant'
  | 'state-default-required';

/** {@link state-already-defined} payload: carries the conflicting name and optional first-definition site. */
export interface StateAlreadyDefinedDetail {
  readonly code: 'state-already-defined';
  readonly name: string;
  readonly firstDefinedAt: string | undefined;
}

/** {@link state-not-registered} payload: carries the token name that has no plugin registration. */
export interface StateNotRegisteredDetail {
  readonly code: 'state-not-registered';
  readonly name: string;
}

/** {@link invalid-variant} payload: carries the token name, the invalid variant string, and the valid variants list. */
export interface InvalidVariantDetail {
  readonly code: 'invalid-variant';
  readonly name: string;
  readonly got: string;
  readonly valid: readonly string[];
}

/** {@link state-default-required} payload: carries the token name whose variants array was empty. */
export interface StateDefaultRequiredDetail {
  readonly code: 'state-default-required';
  readonly name: string;
}

/**
 * Discriminated detail union for {@link StateError}, narrowed per
 * `StateError.code`. AI users obtain the concrete shape via
 * `switch (err.code)` without a fallback `as` cast.
 */
export type StateErrorDetail =
  | StateAlreadyDefinedDetail
  | StateNotRegisteredDetail
  | InvalidVariantDetail
  | StateDefaultRequiredDetail;

/**
 * Structured state-machine error -- four-field surface
 * (`.code` / `.expected` / `.hint` / `.detail`).
 *
 * AI users consume the structured triple by fields, not by parsing `.message`.
 */
export interface StateError {
  readonly code: StateErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: StateErrorDetail;
}

function makeError(
  code: StateErrorCode,
  expected: string,
  hint: string,
  detail: StateErrorDetail,
): StateError {
  return {
    code,
    expected,
    hint,
    detail,
    get message(): string {
      return `[${code}] ${hint}`;
    },
  } as StateError;
}

/** Convenience throw wrapper for programmer errors (defineState constructor phase). */
export function throwStateError(
  code: StateErrorCode,
  expected: string,
  hint: string,
  detail: StateErrorDetail,
): never {
  throw makeError(code, expected, hint, detail);
}

export function stateAlreadyDefined(name: string, firstDefinedAt?: string): StateError {
  return makeError(
    'state-already-defined',
    'Each StateToken name must be registered exactly once at module level',
    `State "${name}" is already defined${firstDefinedAt ? ` (first defined at ${firstDefinedAt})` : ''}. Use the existing token.`,
    { code: 'state-already-defined', name, firstDefinedAt },
  );
}

export function stateNotRegistered(name: string): StateError {
  return makeError(
    'state-not-registered',
    'registerStatesPlugin(world) must be called before using setNextState / getState',
    `State "${name}" has not been registered via registerStatesPlugin. createApp auto-registers the plugin in both canvas and assemble forms.`,
    { code: 'state-not-registered', name },
  );
}

export function invalidVariant(name: string, got: string, valid: readonly string[]): StateError {
  return makeError(
    'invalid-variant',
    `Variant must be one of: ${valid.join(', ')}`,
    `"${got}" is not a valid variant for state "${name}". Did you mean one of: ${valid.join(', ')}? Check for typos.`,
    { code: 'invalid-variant', name, got, valid },
  );
}

export function stateDefaultRequired(name: string): StateError {
  return makeError(
    'state-default-required',
    'defineState requires at least one variant (non-empty array)',
    `State "${name}" was defined with an empty variants array. Provide at least one variant, e.g. defineState("${name}", ["default"] as const).`,
    { code: 'state-default-required', name },
  );
}
