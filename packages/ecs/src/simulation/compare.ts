import { err, ok, type Result } from '@forgeax/engine-types';
import { createSimulationError } from '../errors/simulation-errors';
import type {
  SimulationComparisonDomain,
  SimulationComparisonDomainSummary,
  SimulationComparisonEntry,
  SimulationComparisonFact,
  SimulationComparisonInput,
  SimulationComparisonReport,
  SimulationError,
  SimulationErrorFor,
} from './types';

type SimulationCompareError = SimulationErrorFor<'simulation-compare-invalid'>;

function invalid(path: string, expected: string, received?: unknown): SimulationCompareError {
  return createSimulationError('simulation-compare-invalid', { path, expected, received });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function equalDiscrete(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function compareFact(
  fact: SimulationComparisonFact,
): Result<SimulationComparisonEntry, SimulationCompareError> {
  const expectedNumber = typeof fact.expected === 'number';
  const actualNumber = typeof fact.actual === 'number';
  if (expectedNumber !== actualNumber) {
    return err(invalid(fact.path, 'expected and actual to have the same scalar kind'));
  }
  if (expectedNumber && actualNumber) {
    if (!Number.isFinite(fact.expected) || !Number.isFinite(fact.actual)) {
      return err(invalid(fact.path, 'finite expected and actual numbers'));
    }
    if (fact.tolerance === undefined || !Number.isFinite(fact.tolerance) || fact.tolerance < 0) {
      return err(
        invalid(
          `${fact.domain}.${fact.path}`,
          'a finite non-negative field tolerance',
          fact.tolerance,
        ),
      );
    }
    const difference = Math.abs(fact.actual - fact.expected);
    return ok({
      ...fact,
      difference,
      verdict: difference <= fact.tolerance ? 'match' : 'mismatch',
    });
  }
  if (fact.tolerance !== undefined) {
    return err(invalid(fact.path, 'no tolerance for a discrete field', fact.tolerance));
  }
  return ok({
    ...fact,
    verdict: equalDiscrete(fact.expected, fact.actual) ? 'match' : 'mismatch',
  });
}

function summary(
  entries: readonly SimulationComparisonEntry[],
  domain: SimulationComparisonEntry['domain'],
) {
  const scoped = entries.filter((entry) => entry.domain === domain);
  return {
    compared: scoped.length,
    mismatches: scoped.filter((entry) => entry.verdict === 'mismatch').length,
  } as const;
}

/** Compare semantic facts with explicit numeric tolerances and produce a report-only result. */
export function simulationCompare(
  input: SimulationComparisonInput,
): Result<SimulationComparisonReport, SimulationCompareError> {
  const entries: SimulationComparisonEntry[] = [];
  for (const fact of input.facts) {
    if (fact.path.length === 0) return err(invalid('path', 'a non-empty semantic field path'));
    const compared = compareFact(fact);
    if (!compared.ok) return compared;
    entries.push(compared.value);
  }
  const mismatches = entries.filter((entry) => entry.verdict === 'mismatch');
  return ok({
    verdict: mismatches.length === 0 ? 'match' : 'mismatch',
    entries: Object.freeze(entries),
    mismatches: Object.freeze(mismatches),
    cleanup: summary(entries, 'cleanup'),
    finalInvariants: summary(entries, 'final-invariant'),
  });
}

export type {
  SimulationComparisonDomain,
  SimulationComparisonDomainSummary,
  SimulationComparisonEntry,
  SimulationComparisonFact,
  SimulationComparisonInput,
  SimulationComparisonReport,
  SimulationError,
};
