import { describe, expect, it } from 'vitest';
import {
  createVisibilityBudget,
  DEFAULT_CONFIGURED_QUERY_BUDGET,
  MAX_QUERY_BUDGET,
} from '../scene/visibility/budget';

describe('visibility budget derivation', () => {
  it.each([
    [
      2048,
      {
        effectiveQueryBudget: 2048,
        oneSweepCandidates: 49,
        oneSweepOccluded: 44,
        settleSubmits: 98,
        retestSubmits: 44,
        expirySubmits: 88,
      },
    ],
    [
      4096,
      {
        effectiveQueryBudget: 4096,
        oneSweepCandidates: 25,
        oneSweepOccluded: 22,
        settleSubmits: 50,
        retestSubmits: 22,
        expirySubmits: 44,
      },
    ],
  ])('derives the approved windows for Q=%d', (configuredQueryBudget, expected) => {
    expect(createVisibilityBudget(configuredQueryBudget)).toMatchObject({
      configuredQueryBudget,
      ...expected,
    });
  });

  it('uses the default and clamps larger configured budgets without changing page policy', () => {
    expect(createVisibilityBudget()).toMatchObject({
      configuredQueryBudget: DEFAULT_CONFIGURED_QUERY_BUDGET,
      effectiveQueryBudget: DEFAULT_CONFIGURED_QUERY_BUDGET,
    });
    expect(createVisibilityBudget(MAX_QUERY_BUDGET + 1).effectiveQueryBudget).toBe(
      MAX_QUERY_BUDGET,
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid configured budget %s', (configuredQueryBudget) => {
    expect(() => createVisibilityBudget(configuredQueryBudget)).toThrow(
      'configuredQueryBudget must be a positive safe integer',
    );
  });

  it.each([1, 2, 3, 4, 8])('keeps derived windows independent of %d LOD levels', (levels) => {
    const budget = createVisibilityBudget(2048);
    expect({ levels, ...budget }).toMatchObject({
      levels,
      settleSubmits: 98,
      retestSubmits: 44,
      expirySubmits: 88,
    });
  });
});
