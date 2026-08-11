import { describe, expect, it } from 'vitest';
import { type SimulationComparisonFact, simulationCompare } from '../compare';

function fact(overrides: Partial<SimulationComparisonFact> = {}): SimulationComparisonFact {
  return {
    domain: 'world',
    path: 'entities[0].position.x',
    expected: 1,
    actual: 1,
    tolerance: 0,
    ...overrides,
  };
}

describe('simulation semantic compare report', () => {
  it('returns domain/path entries with expected, actual, tolerance, and verdict', () => {
    const result = simulationCompare({
      facts: [
        fact(),
        fact({
          domain: 'collision',
          path: 'events[0].kind',
          expected: 'enter',
          actual: 'enter',
          tolerance: undefined,
        }),
        fact({
          domain: 'cleanup',
          path: 'despawnedCount',
          expected: 2,
          actual: 2,
          tolerance: 0,
        }),
        fact({
          domain: 'final-invariant',
          path: 'danglingEntityRefs',
          expected: 0,
          actual: 0,
          tolerance: 0,
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('match');
    expect(result.value.entries[0]).toMatchObject({
      domain: 'world',
      path: 'entities[0].position.x',
      expected: 1,
      actual: 1,
      tolerance: 0,
      verdict: 'match',
    });
    expect(result.value.cleanup).toEqual({ compared: 1, mismatches: 0 });
    expect(result.value.finalInvariants).toEqual({ compared: 1, mismatches: 0 });
  });

  it('uses field-level tolerance for finite numbers and exact equality for discrete events', () => {
    const result = simulationCompare({
      facts: [
        fact({ expected: 1, actual: 1.05, tolerance: 0.1 }),
        fact({
          domain: 'audio',
          path: 'events',
          expected: ['play', 'stop'],
          actual: ['stop', 'play'],
          tolerance: undefined,
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('mismatch');
    expect(result.value.entries[0]?.verdict).toBe('match');
    expect(result.value.entries[1]?.verdict).toBe('mismatch');
    expect(result.value.mismatches).toHaveLength(1);
  });

  it('fails closed when a numeric field lacks a finite non-negative tolerance', () => {
    for (const tolerance of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = simulationCompare({ facts: [fact({ tolerance })] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('simulation-compare-invalid');
        expect(result.error.detail.path).toBe('world.entities[0].position.x');
      }
    }
  });

  it('fails closed on non-finite expected or actual values', () => {
    const expected = simulationCompare({ facts: [fact({ expected: Number.NaN })] });
    const actual = simulationCompare({ facts: [fact({ actual: Number.POSITIVE_INFINITY })] });

    expect(expected.ok).toBe(false);
    expect(actual.ok).toBe(false);
    if (!expected.ok) expect(expected.error.detail.path).toBe(fact().path);
    if (!actual.ok) expect(actual.error.detail.path).toBe(fact().path);
  });
});
