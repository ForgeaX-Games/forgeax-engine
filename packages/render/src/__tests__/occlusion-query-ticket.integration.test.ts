import { describe, expect, it } from 'vitest';
import { OcclusionQueryPool } from '../scene/visibility/occlusion-query-pool';

const identity = (primitiveSlot: number) => ({
  viewKey: 'view-main',
  attachmentId: 'attachment-1',
  deviceGeneration: 8,
  worldGeneration: 3,
  primitiveSlot,
  slotGeneration: 2,
});

describe('occlusion query ticket publication', () => {
  it('does not publish a ticket before the shared submission succeeds', () => {
    const pool = new OcclusionQueryPool();
    const reservation = pool.reserve(identity(1));
    if (reservation === undefined) throw new Error('reservation unavailable');
    expect(
      pool.publish(reservation, { submitted: false, submissionGeneration: 1 }),
    ).toBeUndefined();
    expect(pool.inspect().inFlight).toBe(0);
    expect(pool.publish(reservation, { submitted: true, submissionGeneration: 2 })).toMatchObject({
      queryIndex: reservation.queryIndex,
      pageIndex: reservation.pageIndex,
      submissionGeneration: 2,
      primitiveSlot: 1,
      deviceGeneration: 8,
    });
  });

  it('accepts delayed and out-of-order completions only for matching generation identity', () => {
    const pool = new OcclusionQueryPool();
    const first = pool.reserve(identity(1));
    const second = pool.reserve(identity(2));
    if (first === undefined || second === undefined) throw new Error('reservation unavailable');
    const firstTicket = pool.publish(first, { submitted: true, submissionGeneration: 4 });
    const secondTicket = pool.publish(second, { submitted: true, submissionGeneration: 4 });
    if (firstTicket === undefined || secondTicket === undefined)
      throw new Error('ticket unavailable');
    expect(pool.complete(secondTicket, 0)).toEqual({ status: 'accepted', visible: true });
    expect(pool.complete(firstTicket, 7)).toEqual({ status: 'accepted', visible: true });
    expect(pool.complete({ ...firstTicket, deviceGeneration: 7 }, 0)).toEqual({
      status: 'stale',
      visible: true,
    });
  });
});
