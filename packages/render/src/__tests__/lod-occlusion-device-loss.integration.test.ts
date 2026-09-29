import { describe, expect, it } from 'vitest';
import {
  type ConfidenceState,
  recoverVisibilityAfterDeviceLoss,
} from '../scene/visibility/occlusion-confidence';

describe('LOD occlusion device recovery', () => {
  it('keeps CPU projection visible, drops old generation evidence, and retries once', () => {
    const hidden: ConfidenceState = {
      status: 'hidden',
      zeroStreak: 2,
      successfulSubmits: 4,
      queryable: true,
      dirty: false,
      lastResultGeneration: 7,
    };
    const recovered = recoverVisibilityAfterDeviceLoss(hidden, 8);
    expect(recovered).toMatchObject({
      status: 'visible',
      queryable: true,
      dirty: true,
      successfulSubmits: 0,
      lastResultGeneration: undefined,
      retryCount: 1,
    });
  });
});
