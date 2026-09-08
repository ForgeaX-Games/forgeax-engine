import { describe, expect, it } from 'vitest';
import {
  getSsaoParameters,
  resolveSsaoParameters,
  SSAO_DEFAULT_BIAS,
  SSAO_DEFAULT_INTENSITY,
  SSAO_DEFAULT_RADIUS,
} from '../ssao-config';

describe('SSAO parameter authority', () => {
  it('keeps the documented defaults in one resolver', () => {
    expect(getSsaoParameters(undefined)).toEqual({
      radius: SSAO_DEFAULT_RADIUS,
      bias: SSAO_DEFAULT_BIAS,
      intensity: SSAO_DEFAULT_INTENSITY,
    });
  });

  it('preserves configured radius, bias, and intensity', () => {
    expect(getSsaoParameters({ radius: 0.65, bias: 0.025, intensity: 1.4 })).toEqual({
      radius: 0.65,
      bias: 0.025,
      intensity: 1.4,
    });
  });

  it('returns structured failures for invalid radius and bias', () => {
    const invalidRadius = resolveSsaoParameters({ radius: 0 });
    const invalidBias = resolveSsaoParameters({ bias: -0.1 });
    expect(invalidRadius.ok).toBe(false);
    expect(invalidBias.ok).toBe(false);
    if (invalidRadius.ok || invalidBias.ok) throw new Error('expected structured SSAO failures');
    expect(invalidRadius.error.code).toBe('ssao-radius-non-positive');
    expect(invalidBias.error.code).toBe('ssao-bias-negative');
  });
});
