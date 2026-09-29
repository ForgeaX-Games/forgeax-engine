import { describe, expect, it } from 'vitest';
import { resolveReflectionFallbackTemporalReset } from '../temporal/frame-coordinator';

describe('fallback generation temporal boundary', () => {
  it('resets only when a committed semantic generation changes', () => {
    expect(resolveReflectionFallbackTemporalReset(4, 4)).toEqual({ reset: false });
    expect(resolveReflectionFallbackTemporalReset(4, 5)).toEqual({
      reset: true,
      reason: 'reflection-fallback-generation',
    });
  });

  it('does not create a temporal demand for an unavailable projection', () => {
    expect(resolveReflectionFallbackTemporalReset(undefined, 4)).toEqual({ reset: false });
  });
});
