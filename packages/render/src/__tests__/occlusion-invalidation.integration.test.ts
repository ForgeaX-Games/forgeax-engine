import { describe, expect, it } from 'vitest';
import {
  applyConfidenceEvent,
  createConfidenceState,
  type InvalidationReason,
} from '../scene/visibility/occlusion-confidence';

describe('occlusion confidence invalidation matrix', () => {
  it.each([
    'cut',
    'teleport',
    'resize',
    'projection',
    'primitive',
    'bounds',
    'topology',
    'world-reorder',
    'detach',
    'failed-submit',
    'device-loss',
  ] satisfies readonly InvalidationReason[])('invalidates %s without suppressing the facet', (reason) => {
    const state = applyConfidenceEvent(
      applyConfidenceEvent(createConfidenceState(), {
        type: 'result',
        samples: 0,
        submissionGeneration: 1,
      }),
      { type: 'result', samples: 0, submissionGeneration: 2 },
    );
    const next = applyConfidenceEvent(state, { type: 'invalidate', reason });
    expect(next).toMatchObject({
      status: 'visible',
      zeroStreak: 0,
      queryable: reason !== 'detach',
    });
  });
});
