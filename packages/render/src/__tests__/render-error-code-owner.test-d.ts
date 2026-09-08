import { describe, expectTypeOf, it } from 'vitest';
import type {
  ObservationUnavailableDetail,
  ObservationUnavailableReason,
  RenderError,
  RenderErrorCode,
} from '../errors/render';
import { ObservationUnavailableError, RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureErrorCode, RenderFeatureStageFailedDetail } from '../features/types';
import type { RenderFeatureRecovery, RenderFeatureStage } from '../features/vocabulary';
import type {
  RenderError as PublicRenderError,
  RenderErrorCode as PublicRenderErrorCode,
} from '../index';

const expectedCodes = [
  'lifecycle-construction-failed',
  'world-lease-invalid',
  'frame-input-invalid',
  'scene-projection-failed',
  'asset-binding-failed',
  'feature-plan-failed',
  'graph-build-failed',
  'device-operation-failed',
  'surface-unavailable',
  'renderer-state-invalid',
  'recovery-failed',
  'cleanup-failed',
  'frame-receipt-stale',
  'renderer-contract-failed',
  'observation-unavailable',
  'shadow-invalid-config',
  'equirect-projection-failed',
  'hdrp-light-budget-exceeded',
  'hdrp-index-list-overflow',
  'hdrp-deferred-caps-insufficient',
  'point-shadow-atlas-uninitialized',
  'point-shadow-atlas-bounds-violation',
  'video-upload-unsupported',
  'vertex-storage-buffer-unavailable',
  'vertex-color-variant-conflict',
  'skin-palette-overflow',
  'skin-material-mismatch',
  'material-skin-attr-missing',
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
  'points-lines-invalid-style',
  'points-lines-topology-mismatch',
  'points-lines-style-unsupported',
  'points-lines-material-unsupported',
  'points-lines-budget-exceeded',
  'points-lines-prepare-failed',
] as const satisfies readonly RenderErrorCode[];
type ExpectedCodeUnion = (typeof expectedCodes)[number];

const expectedFeatureCodes = [
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
] as const satisfies readonly RenderFeatureErrorCode[];
type ExpectedFeatureCodeUnion = (typeof expectedFeatureCodes)[number];

describe('RenderError code owner', () => {
  it('derives the exact code union from RenderError and preserves projections', () => {
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<ExpectedCodeUnion>();
    expectTypeOf<ExpectedCodeUnion>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<RenderError['code']>();
    expectTypeOf<RenderError['code']>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<PublicRenderErrorCode>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<PublicRenderErrorCode>();
    expectTypeOf<PublicRenderError>().toEqualTypeOf<RenderError>();
    expectTypeOf<RenderFeatureErrorCode>().toEqualTypeOf<ExpectedFeatureCodeUnion>();
    expectTypeOf<ExpectedFeatureCodeUnion>().toEqualTypeOf<RenderFeatureErrorCode>();

    const acceptsCode = (code: RenderErrorCode): RenderErrorCode => code;
    acceptsCode(expectedCodes[0]);
    // @ts-expect-error unknown codes remain outside the closed RenderErrorCode union.
    acceptsCode('render-error-code-not-real');
    // @ts-expect-error unknown codes cannot be assigned to the public alias either.
    const unknownCode: PublicRenderErrorCode = 'render-error-code-not-real';
    void unknownCode;
  });

  it('preserves correlated detail and value declarations', () => {
    type ObservationError = Extract<RenderError, { readonly code: 'observation-unavailable' }>;
    expectTypeOf<ObservationError['detail']>().toEqualTypeOf<ObservationUnavailableDetail>();
    expectTypeOf<
      ObservationError['detail']['reason']
    >().toEqualTypeOf<ObservationUnavailableReason>();
    expectTypeOf<ObservationError['detail']['recovery']>().toEqualTypeOf<
      ObservationUnavailableDetail['recovery']
    >();

    const observation = new ObservationUnavailableError('stale', 'draw a current frame');
    expectTypeOf(observation).toEqualTypeOf<ObservationError>();
    expectTypeOf(observation.code).toEqualTypeOf<'observation-unavailable'>();
    expectTypeOf(observation.detail.reason).toEqualTypeOf<ObservationUnavailableReason>();

    type StageFailedError = Extract<RenderError, { readonly code: 'render-feature-stage-failed' }>;
    expectTypeOf<StageFailedError['detail']>().toEqualTypeOf<RenderFeatureStageFailedDetail>();

    const stageFailed = new RenderFeatureStageFailedError('test.feature', 0, 'plan', 'next-frame');
    expectTypeOf(stageFailed).toEqualTypeOf<StageFailedError>();
    expectTypeOf(stageFailed.detail.stage).toEqualTypeOf<RenderFeatureStage>();
    expectTypeOf(stageFailed.detail.recovery).toEqualTypeOf<RenderFeatureRecovery>();
  });
});
