import type { CaseReport, NamedCaptures, ParityProvenance, SceneCaseBudget } from '../contracts/types';
import { parityError, type ColorLightingParityError } from '../errors';
import {
  firstDivergence,
  hasUnreasonablyWideBudget,
  metricsAreFinite,
  type EvaluatorMetrics,
} from './metrics';

export interface EvaluateCaseInput {
  readonly caseId: string;
  readonly required: boolean;
  readonly budget: SceneCaseBudget;
  readonly forgeax: ParityProvenance;
  readonly three: ParityProvenance;
  readonly captures?: {
    readonly forgeax: NamedCaptures;
    readonly three: NamedCaptures;
  };
  readonly analytic?: { readonly max: number };
  readonly roi?: { readonly max: number };
  readonly bytes?: { readonly differing: number };
  readonly aggregateDiff?: number;
  readonly allowThreeWebglFallback?: boolean;
}

export type EvaluationResult =
  | { readonly ok: true; readonly value: CaseReport }
  | { readonly ok: false; readonly error: ColorLightingParityError; readonly value?: CaseReport };

function emptyCaptures(): NamedCaptures {
  return { linear: [], final: [], hash: '' };
}

function buildReport(input: EvaluateCaseInput, metrics: EvaluatorMetrics, verdict: CaseReport['verdict'], divergence: ReturnType<typeof firstDivergence>): CaseReport {
  return {
    schemaVersion: 1,
    caseId: input.caseId,
    required: input.required,
    provenance: { forgeax: input.forgeax, three: input.three },
    captures: input.captures ?? { forgeax: emptyCaptures(), three: emptyCaptures() },
    budget: input.budget,
    metrics,
    verdict,
    status: verdict === 'passed' ? 'complete' : 'failed',
    firstDivergence: divergence,
  };
}

function fail(error: ColorLightingParityError, value?: CaseReport): EvaluationResult {
  return value ? { ok: false, error, value } : { ok: false, error };
}

export function evaluateCase(input: EvaluateCaseInput): EvaluationResult {
  if (input.aggregateDiff !== undefined && input.analytic === undefined && input.roi === undefined) {
    return fail(parityError('aggregate-only-input', { code: 'aggregate-only-input', fields: ['aggregateDiff'] }));
  }
  if (input.forgeax.implementation === input.three.implementation && input.forgeax.version === input.three.version) {
    return fail(parityError('provenance-conflict', {
      code: 'provenance-conflict',
      forgeaxImplementation: input.forgeax.implementation,
      threeImplementation: input.three.implementation,
    }));
  }
  if (
    input.three.renderer !== undefined
    && input.three.renderer !== 'webgpu'
    && !(input.allowThreeWebglFallback && input.three.renderer === 'webgl')
  ) {
    return fail(parityError('primary-capture-missing', { code: 'primary-capture-missing', missing: ['threeWebGpu'] }));
  }
  if (hasUnreasonablyWideBudget(input.budget)) {
    return fail(parityError('budget-exceeded', {
      code: 'budget-exceeded',
      metric: 'analytic',
      actual: input.budget.analyticMax,
      budget: 1,
    }));
  }
  const metrics: EvaluatorMetrics = {
    analyticMax: input.analytic?.max ?? 0,
    roiMax: input.roi?.max ?? 0,
    differingBytes: input.bytes?.differing ?? 0,
  };
  if (!metricsAreFinite(metrics)) {
    return fail(parityError('metric-non-finite', {
      code: 'metric-non-finite',
      metric: 'analytic',
      actual: metrics.analyticMax,
      budget: input.budget.analyticMax,
    }));
  }
  // WebGL2 fallback captures are final-display evidence only. Their raw byte
  // diff remains in the report, while the declared analytic/ROI bounds are
  // the bounded numeric verdict because the fallback has no linear HDR seam
  // and backend quantization can touch every display byte.
  const divergence = firstDivergence(metrics, input.budget, {
    enforceByteBudget: !input.allowThreeWebglFallback,
  });
  if (divergence) {
    const report = buildReport(input, metrics, 'failed', divergence);
    return fail(parityError('budget-exceeded', { code: 'budget-exceeded', metric: divergence.metric, actual: divergence.actual, budget: divergence.budget }), report);
  }
  if (input.captures === undefined) {
    return fail(parityError('primary-capture-missing', { code: 'primary-capture-missing', missing: ['forgeax', 'threeWebGpu'] }));
  }
  return { ok: true, value: buildReport(input, metrics, 'passed', null) };
}
