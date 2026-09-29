import { describe, expect, it } from 'vitest';
import { summarizeIntervalSet } from '../../../../apps/hello/ssr/scripts/smoke-performance-sequence-aggregation.mjs';

describe('SSR performance sequence interval aggregation', () => {
  it('keeps outer span across disjoint intervals while union stays disjoint', () => {
    const summary = summarizeIntervalSet([
      { passName: 'first', beginning: 0n, end: 10n },
      { passName: 'second', beginning: 20n, end: 30n },
    ]);

    expect(summary.outerSpanTicks).toBe('30');
    expect(summary.unionTicks).toBe('20');
    expect(summary.duplicatedTicks).toBe('0');
  });
});
