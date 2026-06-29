// @forgeax/engine-plugin -- thin protocol-layer package for Plugin interface + PluginError.
//
// Only depends on @forgeax/engine-ecs (for World, Result, ok, err).
// Public consumption through @forgeax/engine-app re-export (D-1c).
// Capability package authors import Plugin/PluginError directly from this package.
//
// charter awareness:
//   P3 explicit failure: PluginError carries .code / .expected / .hint / .detail
//       -- AI users consume by property access, not message parsing.
//   P4 consistent abstraction: one Plugin shape for all capability packages.

import type { Result, World } from '@forgeax/engine-ecs';

// ---------------------------------------------------------------------------
// Plugin interface (AC-01) -- the unified entry point for wiring capability
// packages into a forgeax Engine World.
//
// Constraints:
//   - C-8: `name` is kebab-case (e.g. 'physics', 'audio', 'my-tool').
//     Factory functions are camelCase (e.g. `physicsPlugin()`).
//   - `build` may be async; the plugin runner awaits each in order (D-1).
//   - `build` returns `Result<void, PluginError>` -- plugins that wrap
//     existing void register functions signal success with
//     `return ok(undefined)` (D-10).
// ---------------------------------------------------------------------------
export interface Plugin {
  readonly name: string;
  build(world: World): Result<void, PluginError> | Promise<Result<void, PluginError>>;
}

// ---------------------------------------------------------------------------
// PluginError -- closed 2-member union mirroring AppError template (D-7).
//
// PluginErrorCode is a separate closed union from AppErrorCode (C-7 / AC-11);
// the two never intersect. AI users switch-exhaust on PluginErrorCode without
// a default branch, same pattern as AppErrorCode.
//
// Related: requirements AC-04 / AC-05 / AC-11; plan-strategy D-7; charter P3.
// ---------------------------------------------------------------------------

/**
 * Closed PluginErrorCode union (2 members).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'duplicate-plugin'` | two or more plugins share the same `name` in the merged plugins list |
 * | `'plugin-build-failed'` | one or more `plugin.build(world)` calls returned `Result.err` |
 *
 * Independent closed union -- does NOT extend AppErrorCode (C-7 / AC-11).
 */
export type PluginErrorCode = 'duplicate-plugin' | 'plugin-build-failed';

/**
 * Detail variant for the `'duplicate-plugin'` arm.
 *
 * `name` carries the conflicting plugin name so AI users can locate the
 * duplicate without scanning the full plugin list.
 */
export interface PluginDetailDuplicatePlugin {
  readonly name: string;
}

/**
 * Detail variant for the `'plugin-build-failed'` arm.
 *
 * `pluginName` / `cause` carry the first failure (AC-05 lower bound: first
 * failure is always readable). `failures` accumulates every failed plugin
 * so AI users can diagnose multi-plugin build failures in one pass (D-7).
 */
export interface PluginDetailBuildFailed {
  readonly pluginName: string;
  readonly cause: string;
  readonly failures?: ReadonlyArray<{
    readonly pluginName: string;
    readonly cause: string;
  }>;
}

/**
 * Conditional resolver from `PluginErrorCode` to its detail payload type.
 */
export type PluginErrorDetailFor<C extends PluginErrorCode> = C extends 'duplicate-plugin'
  ? PluginDetailDuplicatePlugin
  : C extends 'plugin-build-failed'
    ? PluginDetailBuildFailed
    : never;

/**
 * Tagged union of `.detail` payloads carried by structured PluginError.
 */
export type PluginErrorDetail = PluginDetailDuplicatePlugin | PluginDetailBuildFailed;

class PluginErrorClass extends Error {
  readonly code: PluginErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PluginErrorDetail;

  constructor(args: {
    code: PluginErrorCode;
    expected: string;
    hint: string;
    detail: PluginErrorDetail;
  }) {
    let suffix = '';
    if (args.code === 'duplicate-plugin') {
      const d = args.detail as PluginDetailDuplicatePlugin;
      suffix = ` (name=${d.name})`;
    } else if (args.code === 'plugin-build-failed') {
      const d = args.detail as PluginDetailBuildFailed;
      const failureCount =
        d.failures !== undefined && d.failures.length > 0 ? ` +${d.failures.length} more` : '';
      suffix = ` (plugin=${d.pluginName}, cause=${d.cause}${failureCount})`;
    }
    super(`[PluginError ${args.code}] expected: ${args.expected}; hint: ${args.hint}${suffix}`);
    this.name = 'PluginError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: a PluginErrorClass instance whose `code` literal
 * narrows to `C` and whose `detail` narrows to `PluginErrorDetailFor<C>`.
 */
type PluginErrorVariant<C extends PluginErrorCode> = PluginErrorClass & {
  readonly code: C;
  readonly detail: PluginErrorDetailFor<C>;
};

/**
 * Public PluginError type -- discriminated union of the 2 variants.
 */
export type PluginError =
  | PluginErrorVariant<'duplicate-plugin'>
  | PluginErrorVariant<'plugin-build-failed'>;

interface PluginErrorConstructor {
  new <C extends PluginErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: PluginErrorDetailFor<C>;
  }): PluginErrorVariant<C>;
  readonly prototype: PluginErrorClass;
}

/**
 * PluginError constructor -- `new PluginError({ code, expected, hint, detail })`.
 *
 * Mirrors the AppError constructor pattern: generic `C` is inferred from the
 * literal `code` argument, narrowing `detail` to the per-code payload and the
 * return type to the corresponding `PluginErrorVariant<C>`.
 */
export const PluginError: PluginErrorConstructor =
  PluginErrorClass as unknown as PluginErrorConstructor;

/**
 * `expected` table -- the engine-side invariant that was violated when each
 * code surfaces.
 *
 * 2 keys; bidirectional assertion in `__tests__/plugin-error.test.ts` locks
 * the count and non-emptiness of every entry.
 */
export const PLUGIN_EXPECTED: Readonly<Record<PluginErrorCode, string>> = {
  'duplicate-plugin': 'each plugin name must be unique within the merged plugins list',
  'plugin-build-failed': 'every plugin.build(world) call must return Result.ok',
};

/**
 * `hint` table -- actionable recovery guidance per code (charter P3).
 *
 * 2 keys; bidirectional assertion in `__tests__/plugin-error.test.ts` locks
 * the count and non-emptiness of every entry.
 */
export const PLUGIN_ERROR_HINTS: Readonly<Record<PluginErrorCode, string>> = {
  'duplicate-plugin':
    'remove or rename the duplicate plugin; check both default and user-provided plugins for name collisions',
  'plugin-build-failed':
    'inspect detail.failures for the complete failure list; check each plugin build implementation for missing resources or invalid world state',
};

/**
 * Type guard for narrowing an unknown error to PluginError.
 *
 * Mirrors `isAppError` -- AI users call `if (isPluginError(err))` before
 * walking `.code`.
 */
export function isPluginError(err: unknown): err is PluginError {
  return err instanceof PluginErrorClass;
}
