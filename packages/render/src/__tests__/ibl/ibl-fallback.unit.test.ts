import { describe, expect, it } from 'vitest';
import { describeIblCapability } from '../../ibl/cubemap-projection';

describe('IBL capability fallback contract', () => {
  it.each([
    [true, 'supported', 'complete', 'passed'],
    [false, 'degraded', 'notExecuted', 'failed'],
  ] as const)('keeps capability=%s separate from execution and verdict', (supported, capabilityStatus, executionStatus, verdict) => {
    const report = describeIblCapability({ rgba16floatRenderable: supported });

    expect(report.capabilityStatus).toBe(capabilityStatus);
    expect(report.executionStatus).toBe(executionStatus);
    expect(report.verdict).toBe(verdict);
  });

  it('does not classify rgba8 as a silent HDR substitute', () => {
    const report = describeIblCapability({ rgba16floatRenderable: false });

    expect(report.outputFormat).not.toBe('rgba8unorm');
    expect(report.fallbackArtifact).toBe('white-cube');
    expect(report.expectedImpact).toContain('HDR');
  });
});
