import { describe, expect, it } from 'vitest';
import { OcclusionQueryPool } from '../scene/visibility/occlusion-query-pool';

describe('occlusion query RhiNull structure', () => {
  it('keeps zero, positive, out-of-order, and fault completions all-visible', () => {
    const pool = new OcclusionQueryPool();
    const base = {
      viewKey: 'view',
      attachmentId: 'depth-0',
      deviceGeneration: 4,
      worldGeneration: 9,
      primitiveSlot: 2,
      slotGeneration: 3,
    };
    const first = pool.reserve({ ...base, primitiveSlot: 1 });
    const second = pool.reserve({ ...base, primitiveSlot: 2 });
    expect(first && second).toBeTruthy();
    if (first === undefined || second === undefined) return;
    const firstTicket = pool.publish(first, { submitted: true, submissionGeneration: 10 });
    const secondTicket = pool.publish(second, { submitted: true, submissionGeneration: 11 });
    expect(firstTicket && secondTicket).toBeTruthy();
    if (firstTicket === undefined || secondTicket === undefined) return;

    expect(pool.complete(secondTicket, 7)).toMatchObject({ status: 'accepted', visible: true });
    expect(pool.complete(firstTicket, 0)).toMatchObject({ status: 'accepted', visible: true });
    expect(pool.complete({ ...firstTicket, slotGeneration: 99 }, 1)).toMatchObject({
      status: 'stale',
      visible: true,
    });
  });
});
