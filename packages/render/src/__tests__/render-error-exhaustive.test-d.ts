import type {
  RenderError,
  RenderErrorCode,
  RenderFeatureCapabilityMissingError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePassOrderConflictError,
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors';
import type { RenderFeatureErrorCode } from '../features/types';

function renderFeatureCodeLabel(code: RenderFeatureErrorCode): string {
  switch (code) {
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
  }
}

function renderCodeLabel(code: RenderErrorCode): string {
  switch (code) {
    case 'render-feature-registration-conflict':
      return renderFeatureCodeLabel(code);
    case 'render-feature-stage-failed':
      return renderFeatureCodeLabel(code);
    case 'render-feature-capability-missing':
      return renderFeatureCodeLabel(code);
    case 'render-feature-pass-order-conflict':
      return renderFeatureCodeLabel(code);
    default:
      return code;
  }
}

function renderFeatureErrorLabel(error: RenderError): string {
  switch (error.code) {
    case 'render-feature-preparation-failed': {
      const typed: RenderFeaturePreparationFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.resourceName}`;
    }
    case 'render-feature-prepared-state-mismatch': {
      const typed: RenderFeaturePreparedStateMismatchError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.reason}`;
    }
    case 'render-feature-draw-recording-failed': {
      const typed: RenderFeatureDrawRecordingFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.backendReason}`;
    }
    case 'render-feature-registration-conflict': {
      const typed: RenderFeatureRegistrationConflictError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.conflictingOrder}`;
    }
    case 'render-feature-stage-failed': {
      const typed: RenderFeatureStageFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.stage}`;
    }
    case 'render-feature-capability-missing': {
      const typed: RenderFeatureCapabilityMissingError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.capability}`;
    }
    case 'render-feature-pass-order-conflict': {
      const typed: RenderFeaturePassOrderConflictError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.passIdentity}`;
    }
    default:
      return error.expected;
  }
}

void renderCodeLabel;
void renderFeatureErrorLabel;
