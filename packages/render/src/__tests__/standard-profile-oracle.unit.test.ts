import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PROFILE,
  resolveStandardLane,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';

describe('Standard profile oracle', () => {
  it('keeps one identity across the supported light budgets', () => {
    expect(STANDARD_LIGHT_COUNTS).toEqual([1, 32, 256]);
    for (const lightCount of STANDARD_LIGHT_COUNTS) {
      const profile: StandardProfile = {
        ...DEFAULT_STANDARD_PROFILE,
        lightCount,
      };
      expect(profile.pipelineId).toBe(STANDARD_PIPELINE_ID);
      expect(profile.lightCount).toBe(lightCount);
    }
  });

  it('selects direct, clustered, and CPU/WebGL2 fallback lanes from profile and caps', () => {
    expect(
      resolveStandardLane(
        { ...DEFAULT_STANDARD_PROFILE, lighting: 'direct' },
        {
          compute: true,
          storageBuffer: true,
        },
      ),
    ).toBe('direct');
    expect(
      resolveStandardLane(
        { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' },
        {
          compute: true,
          storageBuffer: true,
        },
      ),
    ).toBe('clustered');
    expect(
      resolveStandardLane(
        { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' },
        {
          compute: false,
          storageBuffer: false,
        },
      ),
    ).toBe('cpu-webgl2');
  });

  it('keeps the color-domain stage order stable for all profiles', () => {
    expect(DEFAULT_STANDARD_PROFILE.postStages).toEqual([
      'transparent-blend',
      'bloom',
      'tone',
      'fxaa',
      'output',
    ]);
  });
});
