import { describe, expect, it } from 'vitest';
import {
  OCCLUSION_QUERY_PAGE_BYTES,
  OCCLUSION_QUERY_PAGE_COUNT,
  OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
  OcclusionQueryPool,
} from '../scene/visibility/occlusion-query-pool';

const identity = (index: number) => ({
  viewKey: `view-${index}`,
  attachmentId: 'attachment-1',
  deviceGeneration: 4,
  worldGeneration: 2,
  primitiveSlot: index,
  slotGeneration: 9,
});

describe('occlusion query pool budgets', () => {
  it('owns three bounded pages with 4096 indices and 32 KiB resolve/staging each', () => {
    const pool = new OcclusionQueryPool();
    expect(pool.inspect()).toMatchObject({
      pageCount: OCCLUSION_QUERY_PAGE_COUNT,
      pageIndexLimit: OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
      resolveBytes: OCCLUSION_QUERY_PAGE_BYTES,
      stagingBytes: OCCLUSION_QUERY_PAGE_BYTES,
    });
  });

  it('fills one page to the 4096-index boundary before advancing fairly', () => {
    const pool = new OcclusionQueryPool();
    const firstPage = Array.from({ length: OCCLUSION_QUERY_PAGE_INDEX_LIMIT }, (_, index) =>
      pool.reserve(identity(index)),
    );
    expect(firstPage.every((reservation) => reservation !== undefined)).toBe(true);
    expect(firstPage[0]?.queryIndex).toBe(0);
    expect(firstPage.at(-1)?.queryIndex).toBe(OCCLUSION_QUERY_PAGE_INDEX_LIMIT - 1);
    expect(pool.reserve(identity(4096))?.pageIndex).toBe(1);
  });

  it('releases a page only after its tickets retire and then resets its index cursor', () => {
    const pool = new OcclusionQueryPool();
    const first = pool.reserve(identity(0));
    const second = pool.reserve(identity(1));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined)
      throw new Error('test fixture reservations must exist');
    const firstTicket = pool.publish(first, { submitted: true, submissionGeneration: 7 });
    const secondTicket = pool.publish(second, { submitted: true, submissionGeneration: 7 });
    expect(firstTicket).toBeDefined();
    expect(secondTicket).toBeDefined();
    if (firstTicket === undefined || secondTicket === undefined)
      throw new Error('test fixture tickets must exist');
    pool.complete(firstTicket, 1);
    expect(pool.inspect().inFlight).toBe(1);
    pool.complete(secondTicket, 1);
    const reused = pool.reserve(identity(2));
    expect(reused).toMatchObject({ pageIndex: 0, queryIndex: 0 });
  });

  it('does not submit new queries to a page while its staging buffer is in flight', () => {
    const pool = new OcclusionQueryPool();
    const first = pool.reserve(identity(0));
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('test fixture reservation must exist');
    const ticket = pool.publish(first, { submitted: true, submissionGeneration: 7 });
    expect(ticket).toBeDefined();
    if (ticket === undefined) throw new Error('test fixture ticket must exist');

    const next = pool.reserve(identity(1));
    expect(next).toMatchObject({ pageIndex: 1, queryIndex: 0 });
    expect(pool.inspect().availablePages).toBe(OCCLUSION_QUERY_PAGE_COUNT - 1);
    pool.complete(ticket, 1);
  });

  it('reports no reservable pages while every page has an in-flight ticket', () => {
    const pool = new OcclusionQueryPool();
    const tickets = [];
    for (let index = 0; index < OCCLUSION_QUERY_PAGE_COUNT; index += 1) {
      const reservation = pool.reserve(identity(index));
      expect(reservation).toBeDefined();
      if (reservation === undefined) throw new Error('page reservation must exist');
      const ticket = pool.publish(reservation, { submitted: true, submissionGeneration: 8 });
      expect(ticket).toBeDefined();
      if (ticket === undefined) throw new Error('page ticket must exist');
      tickets.push(ticket);
    }

    expect(pool.inspect().availablePages).toBe(0);
    expect(pool.reserve(identity(OCCLUSION_QUERY_PAGE_COUNT))).toBeUndefined();

    for (const ticket of tickets) pool.complete(ticket, 0);
    expect(pool.inspect().availablePages).toBe(OCCLUSION_QUERY_PAGE_COUNT);
  });
});
