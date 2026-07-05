// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): render cluster
// exhaustive type-level regression guard. Split out of the former
// hdrp-error-exhaustive.test-d.ts, which exhaustively switched the whole
// RuntimeErrorCode union; after the D-3 decomposition each cluster owns its own
// exhaustive assertion.
//
// If any RenderErrorCode member is missing from the switch below, the
// `const exhaustive: never = code` line stops compiling (tsc red). A `default`
// arm would defeat the exhaustiveness check, so there is none.
//
// This file is *.test-d.ts: vitest typecheck validates it; it is not executed.

import type { RenderError, RenderErrorCode } from '../errors/render';

function exhaustiveSwitchOnRenderCode(code: RenderErrorCode): string {
  switch (code) {
    case 'shadow-invalid-config':
      return code;
    case 'equirect-projection-failed':
      return code;
    case 'hdrp-caps-insufficient':
      return code;
    case 'hdrp-light-budget-exceeded':
      return code;
    case 'hdrp-index-list-overflow':
      return code;
    case 'hdrp-deferred-caps-insufficient':
      return code;
    case 'gbuffer-rt-alloc-failed':
      return code;
    case 'gbuffer-attachment-count-mismatch':
      return code;
    case 'point-shadow-atlas-uninitialized':
      return code;
    case 'point-shadow-atlas-bounds-violation':
      return code;
    case 'video-upload-unsupported':
      return code;
    case 'vertex-storage-buffer-unavailable':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function narrowRenderError(err: RenderError): void {
  switch (err.code) {
    case 'shadow-invalid-config':
      void err.detail.field; // string
      void err.detail.value; // number
      break;
    case 'equirect-projection-failed':
      void err.detail.handle; // number
      break;
    case 'hdrp-caps-insufficient':
      void err.detail.capName; // string
      void err.detail.actual; // number
      void err.detail.required; // number
      break;
    case 'hdrp-light-budget-exceeded':
      void err.detail.actual; // number
      void err.detail.budget; // number
      break;
    case 'hdrp-index-list-overflow':
      void err.detail.actual; // number
      void err.detail.capacity; // number
      break;
    case 'hdrp-deferred-caps-insufficient':
      void err.detail.actual; // number
      void err.detail.expected; // number
      break;
    case 'gbuffer-rt-alloc-failed':
      void err.detail.attachmentIndex; // number
      void err.detail.requestedBytes; // number
      break;
    case 'gbuffer-attachment-count-mismatch':
      void err.detail.actual; // number
      void err.detail.expected; // number
      break;
    case 'point-shadow-atlas-uninitialized':
      // No detail on this class.
      break;
    case 'point-shadow-atlas-bounds-violation':
      void err.detail.axis; // 'layer' | 'face'
      void err.detail.value; // number
      void err.detail.max; // number
      break;
    case 'video-upload-unsupported':
      // No detail on this class.
      break;
    case 'vertex-storage-buffer-unavailable':
      // No detail on this class.
      break;
    default: {
      const exhaustive: never = err;
      void exhaustive;
    }
  }
}

export type _RenderExhaustiveChecks = {
  /** @internal forces tsc to type-check the exhaustive switch on RenderErrorCode. */
  _check: ReturnType<typeof exhaustiveSwitchOnRenderCode>;
  /** @internal forces tsc to type-check the RenderError detail narrowing. */
  _narrow: typeof narrowRenderError;
};
