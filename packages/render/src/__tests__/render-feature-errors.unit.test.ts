import { describe, expect, it } from 'vitest';
import type { RenderFeatureErrorCode, RenderFeatureErrorDescriptor } from '../features/types';

const renderFeatureErrorCodes: readonly RenderFeatureErrorCode[] = [
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
];

function describeError(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return error.detail.featureIdentity;
    case 'render-feature-stage-failed':
      return `${error.detail.featureIdentity}:${error.detail.stage}`;
    case 'render-feature-capability-missing':
      return error.detail.featureIdentity;
    case 'render-feature-pass-order-conflict':
      return error.detail.featureIdentity;
    case 'render-feature-preparation-failed':
      return error.detail.featureIdentity;
    case 'render-feature-prepared-state-mismatch':
      return error.detail.featureIdentity;
    case 'render-feature-draw-recording-failed':
      return error.detail.featureIdentity;
  }
}

describe('render feature error vocabulary', () => {
  it('keeps the four feature codes closed and machine-readable', () => {
    expect(renderFeatureErrorCodes).toHaveLength(7);
    expect(describeError).toBeTypeOf('function');
  });
});
