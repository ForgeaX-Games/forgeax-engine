import { describe, expect, it } from 'vitest';
import { OcclusionQueryPool } from '../scene/visibility/occlusion-query-pool';

describe('occlusion query RhiNull structure', () => {
  it('disposes pages and reuses them without exposing query identity', () => {
    const pool = new OcclusionQueryPool();
    expect(pool.inspect().disposed).toBe(false);
    pool.dispose();
    expect(pool.inspect()).toMatchObject({ disposed: true, inFlight: 0, availablePages: 0 });
    expect(
      pool.reserve({
        viewKey: 'view',
        attachmentId: 'attachment',
        deviceGeneration: 1,
        worldGeneration: 1,
        primitiveSlot: 0,
        slotGeneration: 1,
      }),
    ).toBeUndefined();
  });
});
