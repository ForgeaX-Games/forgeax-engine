// @forgeax/engine-runtime - render-pipeline error model
// (feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w4).
//
// Closed 2-member PipelineErrorCode union + PipelineError discriminated-union class. Two
// failure channels split by error nature (charter P3 + plan-strategy D-E):
//   - 'pipeline-already-registered' (programmer error) -> registerPipeline THROWS a
//     PipelineError, mirroring ShaderRegistry.registerMaterialShader's Map.has -> throw
//     fail-fast (research Finding 3). A second register under the same id is a coding
//     mistake that must surface immediately.
//   - 'pipeline-not-found' (runtime path) -> installPipeline returns Result.err with this
//     code when the supplied handle resolves to no registered pipeline (stale / wrong
//     handle). AI users branch on `err.code === 'pipeline-not-found'` by property access.
//
// D-1: a NEW independent union rather than folding into RuntimeErrorCode /
// RenderGraphErrorCode (requirements OOS-6). RuntimeErrorCode's members are render / skin
// / shadow domain; a separate union keeps the pipeline error surface cohesive and
// additively evolvable (mirrors pick-errors.ts D-1 reasoning verbatim).
//
// PipelineError is exposed as a discriminated union (variant per code, AppError pattern)
// so `if (err.code === 'X')` simultaneously narrows `err.detail` to the per-code payload.
//
// Related: requirements M1 item 8 + AC-05 / AC-06; plan-strategy D-E; charter P3 / P4.

/**
 * Closed union of render-pipeline error codes.
 *
 * Exactly 2 members; AI users perform exhaustive `switch (err.code)` without a default
 * and TS guards completeness (AC-05).
 *
 * | code | channel | trigger |
 * |:--|:--|:--|
 * | `'pipeline-already-registered'` | throw | a second `registerPipeline(id, impl)` under an already-registered `id` |
 * | `'pipeline-not-found'` | `Result.err` | `installPipeline(handle)` where the handle resolves to no registered pipeline |
 */
export type PipelineErrorCode = 'pipeline-already-registered' | 'pipeline-not-found';

/**
 * Detail for `'pipeline-already-registered'`: the pipeline id that was already taken.
 * AI consumers read `.detail.id` by property access (charter P4), no message parsing.
 */
export interface PipelinePreviouslyRegisteredDetail {
  readonly id: string;
}

/**
 * Detail for `'pipeline-not-found'`: the raw u32 handle value that resolved to no
 * registered pipeline. Read via `.detail.handle` after the code guard.
 */
export interface PipelineNotFoundDetail {
  readonly handle: number;
}

/**
 * Conditional resolver from `PipelineErrorCode` to its detail payload type. Used by the
 * constructor signature so `new PipelineError({ code: 'X', detail })` narrows the
 * `detail` parameter to the variant payload at compile time.
 */
export type PipelineErrorDetailFor<C extends PipelineErrorCode> =
  C extends 'pipeline-already-registered'
    ? PipelinePreviouslyRegisteredDetail
    : C extends 'pipeline-not-found'
      ? PipelineNotFoundDetail
      : never;

/**
 * Tagged union of `.detail` payloads. The variants are unique by structural fields
 * (`{ id }` vs `{ handle }`).
 */
export type PipelineErrorDetail = PipelinePreviouslyRegisteredDetail | PipelineNotFoundDetail;

const PIPELINE_EXPECTED: { readonly [C in PipelineErrorCode]: string } = {
  'pipeline-already-registered': 'each pipeline id is registered at most once',
  'pipeline-not-found': 'installPipeline receives a handle to a registered pipeline',
};

function pipelineHint(code: PipelineErrorCode, detail: PipelineErrorDetail): string {
  switch (code) {
    case 'pipeline-already-registered':
      return (
        `pipeline id '${(detail as PipelinePreviouslyRegisteredDetail).id}' is already ` +
        'registered; same-id re-register is forbidden. Pick a distinct id ' +
        '(engine builtins use the forgeax:: prefix; user pipelines use <package>::<id>).'
      );
    case 'pipeline-not-found':
      return (
        `no pipeline is registered for handle ${(detail as PipelineNotFoundDetail).handle}. ` +
        'First registerPipeline(id, impl), then register a RenderPipelineAsset ' +
        '{ kind:"render-pipeline", pipelineId: id } and install the returned handle.'
      );
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

class PipelineErrorClass extends Error {
  readonly code: PipelineErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PipelineErrorDetail;

  constructor(args: { code: PipelineErrorCode; detail: PipelineErrorDetail }) {
    const hint = pipelineHint(args.code, args.detail);
    super(`pipeline: ${args.code} (${hint})`);
    this.name = 'PipelineError';
    this.code = args.code;
    this.expected = PIPELINE_EXPECTED[args.code];
    this.hint = hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: a `PipelineErrorClass` instance whose `code` literal narrows to
 * `C` and whose `detail` narrows to `PipelineErrorDetailFor<C>`, so `if (err.code === 'X')`
 * simultaneously narrows `err.detail` (charter P3 + P4 discriminated union).
 */
type PipelineErrorVariant<C extends PipelineErrorCode> = PipelineErrorClass & {
  readonly code: C;
  readonly detail: PipelineErrorDetailFor<C>;
};

/**
 * Public PipelineError type - discriminated union of the 2 variants.
 *
 * ```ts
 * function recover(err: PipelineError): string {
 *   switch (err.code) {
 *     case 'pipeline-already-registered': return `id taken: ${err.detail.id}`;
 *     case 'pipeline-not-found':          return `bad handle: ${err.detail.handle}`;
 *   }
 * }
 * ```
 */
export type PipelineError =
  | PipelineErrorVariant<'pipeline-already-registered'>
  | PipelineErrorVariant<'pipeline-not-found'>;

interface PipelineErrorConstructor {
  new <C extends PipelineErrorCode>(args: {
    code: C;
    detail: PipelineErrorDetailFor<C>;
  }): PipelineErrorVariant<C>;
  readonly prototype: PipelineErrorClass;
}

/**
 * PipelineError constructor - `new PipelineError({ code, detail })`.
 *
 * The generic `C` is inferred from the literal `code` argument, which narrows `detail` to
 * the per-code payload (`PipelineErrorDetailFor<C>`) and narrows the return type to the
 * corresponding `PipelineErrorVariant<C>` so the call site walks the discriminated union
 * without manual cast (AppError pattern; TS class declarations cannot directly express
 * `<C> ... PipelineErrorVariant<C>` polymorphism, hence the typed-cast affordance).
 */
export const PipelineError: PipelineErrorConstructor =
  PipelineErrorClass as unknown as PipelineErrorConstructor;
