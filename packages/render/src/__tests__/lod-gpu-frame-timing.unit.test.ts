import { describe, expect, it } from 'vitest';
import {
  createGpuFrameTiming,
  recordGpuFrameTiming,
  summarizeGpuFrameTiming,
} from '../scene/visibility/gpu-frame-timing';

describe('renderer-owned GPU frame timing protocol', () => {
  it('joins first render pass and occlusion terminal marker on one submit', () => {
    const timing = createGpuFrameTiming({ frameId: 12, deviceGeneration: 4 });
    const recorded = recordGpuFrameTiming(timing, {
      firstPassTimestampNs: 1_000,
      occlusionResolveTimestampNs: 4_000,
      submitted: true,
      graphGeneration: 8,
      submitId: 3,
    });

    expect(recorded.protocol).toEqual({
      firstMarker: 'frame.first-pass',
      terminalMarker: 'occlusion.resolve-copy',
      sameGraph: true,
      sameSubmit: true,
    });
    expect(summarizeGpuFrameTiming([recorded])).toEqual({ medianUs: 3, p95Us: 3, samples: 1 });
  });

  it('rejects an unsubmitted or cross-submit sample instead of reporting timing', () => {
    const timing = createGpuFrameTiming({ frameId: 13, deviceGeneration: 4 });
    expect(() =>
      recordGpuFrameTiming(timing, {
        firstPassTimestampNs: 1_000,
        occlusionResolveTimestampNs: 4_000,
        submitted: false,
        graphGeneration: 9,
        submitId: 4,
      }),
    ).toThrow(/submitted/i);
    expect(() =>
      recordGpuFrameTiming(timing, {
        firstPassTimestampNs: 1_000,
        occlusionResolveTimestampNs: 4_000,
        submitted: true,
        graphGeneration: 9,
        submitId: 5,
      }),
    ).toThrow(/submit/i);
  });
});
