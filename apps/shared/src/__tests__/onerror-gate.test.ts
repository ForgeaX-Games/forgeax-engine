import { describe, expect, it } from 'vitest';
import { SUT_ATTRIBUTABLE_CODES } from '../onerror-gate';

const rendererReadyFailureCodes = [
  'manifest-malformed',
  'shader-not-found',
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'webgpu-runtime-error',
] as const;

const rendererDrawFailureCodes = [
  'rhi-not-available',
  'webgpu-runtime-error',
  'render-system-empty-worlds',
  'render-system-owner-out-of-range',
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
] as const;

describe('SUT renderer error attribution', () => {
  it('attributes every documented Renderer.ready failure code', () => {
    for (const code of rendererReadyFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('attributes documented Renderer.draw and RenderFeature failures', () => {
    for (const code of rendererDrawFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('does not attribute environment lifecycle noise to the demo', () => {
    expect(SUT_ATTRIBUTABLE_CODES.has('device-lost')).toBe(false);
    expect(SUT_ATTRIBUTABLE_CODES.has('adapter-unavailable')).toBe(false);
  });
});
