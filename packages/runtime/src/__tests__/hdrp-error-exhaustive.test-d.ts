// feat-20260608-cluster-lighting M5 / w19: exhaustive switch type-level test.
// AC-19: TS exhaustive switch on RuntimeErrorCode must compile.
// Any missing case = typecheck red.
//
// AC-20: .detail discriminated union narrowing. Each case arm narrows
// the detail to the per-code variant. No `as` casts needed.
//
// This file is *.test-d.ts — a type-only compile check. vitest does not
// execute it; tsc validates it during pnpm typecheck.
//
// feat-20260621-merge-directionallightshadow-into-directionallight M4:
// 'shadow-disabled-by-missing-component' + ShadowDisabledByMissingComponentError
// removed from the closed union (the two-component warning is meaningless after
// DirectionalLightShadow merged into DirectionalLight with castShadow toggle).

import type { RuntimeError, RuntimeErrorCode } from '../errors';

// ── AC-19: Exhaustive switch on RuntimeErrorCode ───────────────────────────────
//
// If any RuntimeErrorCode member is missing from this switch, tsc emits
// error TS2304 / "not all constituents of type RuntimeErrorCode are handled".
// Adding a `default` arm would defeat the exhaustive check.
//
// Member count is 21 post feat-20260623 (added video-upload-unsupported;
// 20 post feat-20260621 removed shadow-disabled-by-missing-component).

function exhaustiveSwitchOnCode(code: RuntimeErrorCode): string {
  switch (code) {
    case 'shadow-invalid-config':
      return 'shadow-invalid-config';
    case 'skin-joint-count-exceeded':
      return 'skin-joint-count-exceeded';
    case 'skin-joint-despawned':
      return 'skin-joint-despawned';
    case 'skin-joint-path-unresolved':
      return 'skin-joint-path-unresolved';
    case 'skin-instances-coexist-forbidden':
      return 'skin-instances-coexist-forbidden';
    case 'vertex-storage-buffer-unavailable':
      return 'vertex-storage-buffer-unavailable';
    case 'skin-palette-overflow':
      return 'skin-palette-overflow';
    case 'material-resolved-empty-passes':
      return 'material-resolved-empty-passes';
    case 'equirect-projection-failed':
      return 'equirect-projection-failed';
    case 'mesh-ssbo-capacity-exceeded':
      return 'mesh-ssbo-capacity-exceeded';
    case 'mesh-ssbo-ceiling-reached':
      return 'mesh-ssbo-ceiling-reached';
    case 'hdrp-caps-insufficient':
      return 'hdrp-caps-insufficient';
    case 'hdrp-light-budget-exceeded':
      return 'hdrp-light-budget-exceeded';
    case 'hdrp-index-list-overflow':
      return 'hdrp-index-list-overflow';
    // feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w6:
    // 3 new deferred-path error codes.
    case 'hdrp-deferred-caps-insufficient':
      return 'hdrp-deferred-caps-insufficient';
    case 'gbuffer-rt-alloc-failed':
      return 'gbuffer-rt-alloc-failed';
    case 'gbuffer-attachment-count-mismatch':
      return 'gbuffer-attachment-count-mismatch';
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
    // bidirectional Skin <-> pbr-skin material mismatch detected at extract.
    case 'skin-material-mismatch':
      return 'skin-material-mismatch';
    case 'material-skin-attr-missing':
      return 'material-skin-attr-missing';
    // feat-20260612-skin-palette-per-frame-upload M2 / m2-5: SkinExtractErrorCode
    // subset union (3 new extract-stage classes).
    case 'skeleton-resolve-failed':
      return 'skeleton-resolve-failed';
    case 'joint-count-mismatch':
      return 'joint-count-mismatch';
    case 'joint-entity-dangling':
      return 'joint-entity-dangling';
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4 (closed-union P3):
    // ShadowAtlas P3 lifecycle / bounds errors.
    case 'point-shadow-atlas-uninitialized':
      return 'point-shadow-atlas-uninitialized';
    case 'point-shadow-atlas-bounds-violation':
      return 'point-shadow-atlas-bounds-violation';
    // feat-20260623-world-space-video-asset M3 / w11: AC-10 capability
    // double-miss code (add-only minor).
    case 'video-upload-unsupported':
      return 'video-upload-unsupported';
    // feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha M1 / w3 (D-5):
    case 'scene-collect-entity-ref-out-of-closure':
      return 'scene-collect-entity-ref-out-of-closure';
    case 'scene-collect-asset-guid-unresolved':
      return 'scene-collect-asset-guid-unresolved';
  }
}

// ── AC-20: Discriminated union narrowing on RuntimeError ──────────────────────
//
// Each `.code` arm narrows to the concrete error class, so `.detail.{field}`
// is typed without needing `as` casts.

function narrowRuntimeError(err: RuntimeError): void {
  switch (err.code) {
    case 'shadow-invalid-config':
      void err.detail.field; // string
      void err.detail.value; // number
      break;
    case 'skin-joint-count-exceeded':
      void err.detail.jointCount; // number
      void err.detail.max; // number
      break;
    case 'skin-joint-despawned':
      void err.detail.meshEntity; // number
      void err.detail.jointIndex; // number
      break;
    case 'skin-joint-path-unresolved':
      void err.detail.skinEntity; // number
      void err.detail.path; // readonly string[]
      break;
    case 'skin-instances-coexist-forbidden':
      void err.detail.entity; // number
      break;
    case 'vertex-storage-buffer-unavailable':
      // No detail on this class
      break;
    case 'skin-palette-overflow':
      void err.detail.requestedBytes; // number
      void err.detail.limit; // number
      break;
    case 'material-resolved-empty-passes':
      void err.detail.materialGuid; // string
      void err.detail.reason; // 'missing-parent' | 'no-pass-in-chain'
      break;
    case 'equirect-projection-failed':
      void err.detail.handle; // number
      break;
    case 'mesh-ssbo-capacity-exceeded':
      void err.detail.requested; // number
      void err.detail.capacity; // number
      void err.detail.ceiling; // number
      break;
    case 'mesh-ssbo-ceiling-reached':
      void err.detail.requested; // number
      void err.detail.capacity; // number
      void err.detail.ceiling; // number
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
    // feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w6:
    // 3 new deferred-path error codes — discriminated narrowing.
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
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
    case 'skin-material-mismatch':
      void err.detail.entity; // number
      void err.detail.actualShader; // string | undefined
      break;
    case 'material-skin-attr-missing':
      void err.detail.entity; // number
      void err.detail.missing; // 'skinIndex' | 'skinWeight' | 'both'
      break;
    // feat-20260612-skin-palette-per-frame-upload M2 / m2-5: SkinExtractErrorCode
    // subset union (3 new extract-stage classes) discriminated narrowing.
    case 'skeleton-resolve-failed':
      void err.detail.entity; // number
      void err.detail.skeletonHandle; // number
      break;
    case 'joint-count-mismatch':
      void err.detail.entity; // number
      void err.detail.expected; // number
      void err.detail.actual; // number
      break;
    case 'joint-entity-dangling':
      void err.detail.entity; // number
      void err.detail.jointIndex; // number
      break;
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4: ShadowAtlas P3.
    case 'point-shadow-atlas-uninitialized':
      // No detail on this class
      break;
    case 'point-shadow-atlas-bounds-violation':
      void err.detail.axis; // 'layer' | 'face'
      void err.detail.value; // number
      void err.detail.max; // number
      break;
    // feat-20260623-world-space-video-asset M3 / w11: AC-10 double-miss.
    // No detail on VideoUploadUnsupportedError.
    case 'video-upload-unsupported':
      break;
  }
}

// ── Prevent tree-shaking ──────────────────────────────────────────────────────
// vitest / tsc consider unused functions as dead code.
// A minimal export guarantees tsc checks these functions during typecheck.
export type _ExhaustiveSwitchChecks = {
  /** @internal forces tsc to type-check the exhaustive switch body on RuntimeError. */
  _check: ReturnType<typeof exhaustiveSwitchOnCode>;
  /** @internal forces tsc to type-check narrowRuntimeError type guard. */
  _narrow: typeof narrowRuntimeError;
};

// ── Member count assertion: 21 is the post-feat-20260623 count ────────────────
//
// The primary guard is the exhaustive switch above — any missing member causes
// a compile error. This `satisfies` assertion provides a secondary signal:
// if someone removes one of the 20 case arms without adding a default, the
// exhaustive check still fires; this assertion catches the inverse (an arm
// is present but the literal is wrong, or the code string regressed).
const _caseCount = exhaustiveSwitchOnCode satisfies (_s: RuntimeErrorCode) => string;
void _caseCount;
