export const DEFAULT_CONFIGURED_QUERY_BUDGET = 2048;
export const MAX_QUERY_BUDGET = 4096;
export const VISIBILITY_CANDIDATE_COUNT = 100_000;
export const VISIBILITY_OCCLUDED_COUNT = 90_000;

export interface VisibilityBudget {
  readonly configuredQueryBudget: number;
  readonly effectiveQueryBudget: number;
  readonly oneSweepCandidates: number;
  readonly oneSweepOccluded: number;
  readonly settleSubmits: number;
  readonly retestSubmits: number;
  readonly expirySubmits: number;
}

/** Derive every renderer visibility window from one bounded query budget. */
export function createVisibilityBudget(
  configuredQueryBudget = DEFAULT_CONFIGURED_QUERY_BUDGET,
): VisibilityBudget {
  if (!Number.isSafeInteger(configuredQueryBudget) || configuredQueryBudget <= 0) {
    throw new RangeError('configuredQueryBudget must be a positive safe integer');
  }
  const effectiveQueryBudget = Math.min(configuredQueryBudget, MAX_QUERY_BUDGET);
  const oneSweepCandidates = oneSweep(VISIBILITY_CANDIDATE_COUNT, effectiveQueryBudget);
  const oneSweepOccluded = oneSweep(VISIBILITY_OCCLUDED_COUNT, effectiveQueryBudget);
  const retestSubmits = Math.max(6, oneSweepOccluded);
  return Object.freeze({
    configuredQueryBudget,
    effectiveQueryBudget,
    oneSweepCandidates,
    oneSweepOccluded,
    settleSubmits: 2 * oneSweepCandidates,
    retestSubmits,
    expirySubmits: Math.max(8, retestSubmits + oneSweepOccluded),
  });
}

function oneSweep(candidateCount: number, effectiveQueryBudget: number): number {
  return Math.ceil(candidateCount / effectiveQueryBudget);
}
