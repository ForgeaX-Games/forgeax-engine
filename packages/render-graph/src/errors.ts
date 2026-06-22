// @forgeax/engine-render-graph/src/errors.ts — RenderGraphError closed-union
// error model + Result<T, E>.
//
// Shape (plan-strategy D-3):
// - RenderGraphErrorCode = closed 5-member union: 'dangling-read' /
//   'cap-missing' / 'cyclic-dependency' / 'duplicate-resource' / 'unknown-resource'.
// - RenderGraphError extends Error { readonly code; readonly expected;
//   readonly hint; readonly detail } — four-field structured error surface,
//   aligned with RhiError (research Finding 8).
// - RenderGraphErrorDetail = tagged union narrowed by code:
//   - 'dangling-read' / 'unknown-resource' -> { resourceKey, passName }
//   - 'cap-missing' -> { cap, passName }
//   - 'cyclic-dependency' -> { cycle: string[] }
//   - 'duplicate-resource' -> { resourceKey }
// - Result<T, E=RenderGraphError> = binary tag union ('ok' / 'err') +
//   ok() / err() factories, aligned with RhiError Result (research Finding 8).
//
// Related: plan-strategy D-3; research Finding 8; AC-15.

/**
 * Closed RenderGraphErrorCode union (7 members).
 *
 * `switch` exhaustive checks need no default fallback — tsc strict mode
 * guards union completeness (charter proposition 4).
 *
 * | code | trigger | detail variant |
 * |:--|:--|:--|
 * | `'dangling-read'` | pass reads a resource key that no pass writes | `{ resourceKey, passName }` |
 * | `'cap-missing'` | compute/storage pass on a backend without the required cap | `{ cap, passName }` |
 * | `'cyclic-dependency'` | compile() topology sort detected a cycle | `{ cycle: string[] }` |
 * | `'duplicate-resource'` | same resource key registered twice | `{ resourceKey }` |
 * | `'unknown-resource'` | pass references a resource key not registered | `{ resourceKey, passName }` |
 * | `'resource-alloc-failed'` | device.createTexture/createSampler returned RhiError | `{ resourceKey, passName?, rhiCode? }` |
 * | `'invalid-format'` | addColorTarget desc format is not a valid GPU texture format | `{ resourceKey, format, expected: string[] }` |
 */
export type RenderGraphErrorCode =
  | 'dangling-read'
  | 'cap-missing'
  | 'cyclic-dependency'
  | 'duplicate-resource'
  | 'unknown-resource'
  | 'resource-alloc-failed'
  | 'invalid-format';

/** Detail variant for dangling-read and unknown-resource errors. */
export interface DanglingReadDetail {
  readonly resourceKey: string;
  readonly passName: string;
}

/** Detail variant for cap-missing errors. */
export interface CapMissingDetail {
  readonly cap: 'compute' | 'storageBuffer';
  readonly passName: string;
}

/** Detail variant for cyclic-dependency errors. */
export interface CyclicDependencyDetail {
  readonly cycle: readonly string[];
}

/** Detail variant for duplicate-resource errors. */
export interface DuplicateResourceDetail {
  readonly resourceKey: string;
}

/** Detail variant for resource-alloc-failed errors. */
export interface ResourceAllocFailedDetail {
  readonly resourceKey: string;
  readonly passName?: string | undefined;
  readonly rhiCode?: string | undefined;
}

/** Detail variant for invalid-format errors. */
export interface InvalidFormatDetail {
  readonly resourceKey: string;
  readonly format: string;
  readonly expected: readonly string[];
}

/**
 * Tagged union of detail shapes carried by structured RenderGraphError.
 *
 * Narrowing: switch on `err.code` then cast `err.detail` to the
 * corresponding variant. The `dangling-read` and `unknown-resource`
 * codes share DanglingReadDetail.
 */
export type RenderGraphErrorDetail =
  | DanglingReadDetail
  | CapMissingDetail
  | CyclicDependencyDetail
  | DuplicateResourceDetail
  | ResourceAllocFailedDetail
  | InvalidFormatDetail;

/**
 * Structured RenderGraph error.
 *
 * Four readonly fields aligned with AGENTS.md "Errors are structured"
 * and RhiError (research Finding 8):
 * - `.code` — closed union member (L1 key signal).
 * - `.expected` — expected-state description (L2 detail).
 * - `.hint` — actionable recovery guidance (L2 detail).
 * - `.detail` — narrowed payload per code variant (7 variants).
 */
export class RenderGraphError extends Error {
  readonly code: RenderGraphErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderGraphErrorDetail | undefined;

  constructor(args: {
    code: RenderGraphErrorCode;
    expected: string;
    hint: string;
    detail?: RenderGraphErrorDetail | undefined;
  }) {
    super(`[RenderGraphError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'RenderGraphError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

// Result<T, E> + ok / err + ResultOk / ResultErr live in `@forgeax/engine-types`
// (tweak-20260612-result-into-types). Consolidated upstream from this and 4
// other packages' duplicate definitions; the barrel here re-exports them so
// existing `import { err, ok, Result } from '@forgeax/engine-render-graph'`
// consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
