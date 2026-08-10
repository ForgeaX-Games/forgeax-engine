import { describe, expect, it } from 'vitest';
import {
  CUBE_COUNT_DEFAULT,
  PERF_WORKLOAD_SEED,
  cubePositions,
  parseWorkloadOptions,
  positionsChecksum,
  workloadFingerprint,
} from '../workload';

describe('10k cubes workload authority', () => {
  it('keeps the default count, seed, positions, and fingerprint deterministic', () => {
    const options = parseWorkloadOptions(new URLSearchParams());
    expect(options).toEqual({
      ok: true,
      value: { cubeCount: CUBE_COUNT_DEFAULT, pointLightCount: 16, spotLightCount: 16 },
    });
    if (!options.ok) return;
    expect(PERF_WORKLOAD_SEED).toBe(0x010c0b35);
    expect(positionsChecksum(cubePositions(options.value))).toBe('fc215c24');
    expect(workloadFingerprint(options.value)).toContain('hash=');
    expect(workloadFingerprint(options.value)).toBe(workloadFingerprint(options.value));
  });

  it('rejects light overflow and does not clamp explicit scale values', () => {
    const result = parseWorkloadOptions(
      new URLSearchParams({ cubes: '1000', pointLights: '200', spotLights: '57' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('workload-light-budget-exceeded');
    expect(result.error.detail).toEqual({ pointLightCount: 200, spotLightCount: 57 });
  });
});
