// @forgeax/engine-debug-draw -- error model SSOT (feat-20260615-debug-draw M1 / w2)
//
// Closed union DebugDrawErrorCode (4 members), discriminated detail union,
// and structured DebugDrawError carrying .code / .expected / .hint / .detail.
//
// Decision anchors:
// - plan-strategy D-11: destroy-then-flush returns Result.err, shape calls no-op + warn once
// - requirements sec 3.6: error code closed union 4 members
// - AGENTS.md Error model: structured errors with .expected / .hint, never throw
// - architecture-principles #5 Fail Fast: validate at entry, non-conforming data never flows downstream

import { err, type Result } from '@forgeax/engine-types';

/**
 * Closed {@link DebugDrawErrorCode} union -- 4 members.
 * Exhaustive `switch (err.code)` needs no default fallback.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'pipeline-create-failed'` | `device.createRenderPipeline(...)` rejected or threw |
 * | `'buffer-allocation-failed'` | `device.createBuffer(...)` for GPU vbo allocation failed |
 * | `'flushed-after-destroy'` | `flush()` called on an already-destroyed DebugDraw instance |
 * | `'viewProj-required'` | `flush()` called with `undefined` or missing `viewProj` |
 */
export type DebugDrawErrorCode =
  | 'pipeline-create-failed'
  | 'buffer-allocation-failed'
  | 'flushed-after-destroy'
  | 'viewProj-required';

/** {@link pipeline-create-failed} payload: carries the RHI-level error detail. */
export interface PipelineCreateFailedDetail {
  readonly code: 'pipeline-create-failed';
  readonly rhiError: string;
}

/** {@link buffer-allocation-failed} payload: carries the RHI-level error detail. */
export interface BufferAllocationFailedDetail {
  readonly code: 'buffer-allocation-failed';
  readonly rhiError: string;
}

/** {@link flushed-after-destroy} payload: carries the instance identifier. */
export interface FlushedAfterDestroyDetail {
  readonly code: 'flushed-after-destroy';
}

/** {@link viewProj-required} payload: carries the missing parameter name. */
export interface ViewProjRequiredDetail {
  readonly code: 'viewProj-required';
}

/**
 * Discriminated detail union for {@link DebugDrawError}, narrowed per
 * `DebugDrawError.code`. AI users obtain the concrete shape via
 * `switch (err.code)` without a fallback `as` cast.
 */
export type DebugDrawErrorDetail =
  | PipelineCreateFailedDetail
  | BufferAllocationFailedDetail
  | FlushedAfterDestroyDetail
  | ViewProjRequiredDetail;

/**
 * Structured debug-draw error -- four-field surface
 * (`.code` / `.expected` / `.hint` / `.detail`).
 *
 * AI users consume the structured triple by fields, not by parsing `.message`.
 */
export interface DebugDrawError {
  readonly code: DebugDrawErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DebugDrawErrorDetail;
}

function makeError(
  code: DebugDrawErrorCode,
  expected: string,
  hint: string,
  detail: DebugDrawErrorDetail,
): DebugDrawError {
  return {
    code,
    expected,
    hint,
    detail,
    get message(): string {
      return `[${code}] ${hint}`;
    },
  } as DebugDrawError;
}

/** Result-returning helpers consuming engine-types `Result<T, E>` + `err()`. */

export function pipelineCreateFailed(rhiError: string): Result<never, DebugDrawError> {
  return err(
    makeError(
      'pipeline-create-failed',
      'PSO creation should succeed with valid WGSL + layout',
      `Pipeline creation failed: ${rhiError}. Check WGSL syntax, vertex layout, and depth-stencil state.`,
      { code: 'pipeline-create-failed', rhiError },
    ),
  );
}

export function bufferAllocationFailed(rhiError: string): Result<never, DebugDrawError> {
  return err(
    makeError(
      'buffer-allocation-failed',
      'GPU vertex buffer allocation should succeed for the requested byte size',
      `Buffer allocation failed: ${rhiError}. Check available device memory and buffer usage flags.`,
      { code: 'buffer-allocation-failed', rhiError },
    ),
  );
}

export function flushedAfterDestroy(): Result<never, DebugDrawError> {
  return err(
    makeError(
      'flushed-after-destroy',
      'DebugDraw instance is alive and not yet destroyed',
      'DebugDraw was destroyed; create a new instance via createDebugDraw().',
      { code: 'flushed-after-destroy' },
    ),
  );
}

export function viewProjRequired(): Result<never, DebugDrawError> {
  return err(
    makeError(
      'viewProj-required',
      'viewProj must be provided as a Mat4 for flush to transform vertices',
      'Pass a viewProj Mat4 to flush(encoder, view, viewProj).',
      { code: 'viewProj-required' },
    ),
  );
}
