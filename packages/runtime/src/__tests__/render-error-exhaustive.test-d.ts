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

import type { RenderError, RenderErrorCode } from '@forgeax/engine-render';

function exhaustiveSwitchOnRenderCode(code: RenderErrorCode): string {
  switch (code) {
    case 'lifecycle-construction-failed':
      return code;
    case 'world-lease-invalid':
      return code;
    case 'frame-input-invalid':
      return code;
    case 'scene-projection-failed':
      return code;
    case 'asset-binding-failed':
      return code;
    case 'feature-plan-failed':
      return code;
    case 'graph-build-failed':
      return code;
    case 'device-operation-failed':
      return code;
    case 'surface-unavailable':
      return code;
    case 'renderer-state-invalid':
      return code;
    case 'recovery-failed':
      return code;
    case 'cleanup-failed':
      return code;
    case 'frame-receipt-stale':
      return code;
    case 'renderer-contract-failed':
      return code;
    case 'observation-unavailable':
      return code;
    case 'shadow-invalid-config':
      return code;
    case 'equirect-projection-failed':
      return code;
    case 'hdrp-light-budget-exceeded':
      return code;
    case 'hdrp-index-list-overflow':
      return code;
    case 'hdrp-deferred-caps-insufficient':
      return code;
    case 'point-shadow-atlas-uninitialized':
      return code;
    case 'point-shadow-atlas-bounds-violation':
      return code;
    case 'video-upload-unsupported':
      return code;
    case 'vertex-storage-buffer-unavailable':
      return code;
    case 'vertex-color-variant-conflict':
      return code;
    case 'skin-palette-overflow':
      return code;
    case 'skin-material-mismatch':
      return code;
    case 'material-skin-attr-missing':
      return code;
    case 'render-feature-registration-conflict':
      return code;
    case 'render-feature-stage-failed':
      return code;
    case 'render-feature-capability-missing':
      return code;
    case 'render-feature-pass-order-conflict':
      return code;
    case 'render-feature-preparation-failed':
      return code;
    case 'render-feature-prepared-state-mismatch':
      return code;
    case 'render-feature-draw-recording-failed':
      return code;
    case 'points-lines-invalid-style':
      return code;
    case 'points-lines-topology-mismatch':
      return code;
    case 'points-lines-style-unsupported':
      return code;
    case 'points-lines-material-unsupported':
      return code;
    case 'points-lines-budget-exceeded':
      return code;
    case 'points-lines-prepare-failed':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function narrowRenderError(err: RenderError): void {
  switch (err.code) {
    case 'lifecycle-construction-failed':
      void err.detail.owner;
      void err.detail.generation;
      void err.detail.receipt;
      break;
    case 'world-lease-invalid':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'frame-input-invalid':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'scene-projection-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'asset-binding-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'feature-plan-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'graph-build-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'device-operation-failed':
      void err.detail.operation;
      void err.detail.frameId;
      void err.detail.deviceGeneration;
      void err.detail.cause;
      break;
    case 'surface-unavailable':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'renderer-state-invalid':
      void err.detail.operation;
      void err.detail.state;
      void err.detail.cause;
      break;
    case 'recovery-failed':
      void err.detail.operation;
      void err.detail.oldGeneration;
      void err.detail.cause;
      break;
    case 'cleanup-failed':
      void err.detail.operation;
      void err.detail.causes;
      break;
    case 'frame-receipt-stale':
      void err.detail.frameId;
      void err.detail.receiptGeneration;
      void err.detail.currentGeneration;
      break;
    case 'renderer-contract-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'observation-unavailable':
      void err.detail.reason;
      void err.detail.recovery;
      break;
    case 'shadow-invalid-config':
      void err.detail.field; // string
      void err.detail.value; // number
      break;
    case 'equirect-projection-failed':
      void err.detail.handle; // number
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
    case 'skin-palette-overflow':
      void err.detail.requestedBytes;
      void err.detail.limit;
      break;
    case 'skin-material-mismatch':
      void err.detail.entity;
      void err.detail.actualShader;
      break;
    case 'material-skin-attr-missing':
      void err.detail.entity;
      void err.detail.missing;
      break;
    case 'render-feature-registration-conflict':
      void err.detail.featureIdentity;
      void err.detail.conflictingOrder;
      break;
    case 'render-feature-stage-failed':
      void err.detail.featureIdentity;
      void err.detail.stage;
      break;
    case 'render-feature-capability-missing':
      void err.detail.featureIdentity;
      void err.detail.capability;
      break;
    case 'render-feature-pass-order-conflict':
      void err.detail.featureIdentity;
      void err.detail.passIdentity;
      break;
    case 'render-feature-preparation-failed':
      void err.detail.featureIdentity;
      void err.detail.resourceName;
      void err.detail.operation;
      break;
    case 'render-feature-prepared-state-mismatch':
      void err.detail.featureIdentity;
      void err.detail.reason;
      void err.detail.operation;
      break;
    case 'render-feature-draw-recording-failed':
      void err.detail.featureIdentity;
      void err.detail.backendReason;
      void err.detail.operation;
      break;
    case 'vertex-color-variant-conflict':
      void err.detail.authored;
      void err.detail.authoredValue;
      void err.detail.projected;
      break;
    case 'points-lines-invalid-style':
      void err.detail.component;
      void err.detail.field;
      break;
    case 'points-lines-topology-mismatch':
      void err.detail.submesh;
      void err.detail.actual;
      break;
    case 'points-lines-style-unsupported':
      void err.detail.member;
      void err.detail.supported;
      break;
    case 'points-lines-material-unsupported':
      void err.detail.material;
      void err.detail.pass;
      break;
    case 'points-lines-budget-exceeded':
      void err.detail.requested;
      void err.detail.limit;
      break;
    case 'points-lines-prepare-failed':
      void err.detail.owner;
      void err.detail.generation;
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
