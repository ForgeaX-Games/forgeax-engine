import type { SceneCaseBudget } from '../contracts/types';

export interface EvaluatorMetrics {
  readonly analyticMax: number;
  readonly roiMax: number;
  readonly differingBytes: number;
}

export interface MetricDivergence {
  readonly owner: string;
  readonly metric: 'analytic' | 'roi' | 'bytes';
  readonly actual: number;
  readonly budget: number;
}

export interface MetricBudgetOptions {
  readonly enforceByteBudget?: boolean;
}

export function metricsAreFinite(metrics: EvaluatorMetrics): boolean {
  return Number.isFinite(metrics.analyticMax)
    && Number.isFinite(metrics.roiMax)
    && Number.isInteger(metrics.differingBytes)
    && metrics.differingBytes >= 0;
}

export function firstDivergence(
  metrics: EvaluatorMetrics,
  budget: SceneCaseBudget,
  options: MetricBudgetOptions = {},
): MetricDivergence | null {
  if (metrics.analyticMax > budget.analyticMax) {
    return { owner: 'analytic-oracle', metric: 'analytic', actual: metrics.analyticMax, budget: budget.analyticMax };
  }
  if (metrics.roiMax > budget.roiMax) {
    return { owner: 'roi-readback', metric: 'roi', actual: metrics.roiMax, budget: budget.roiMax };
  }
  if (options.enforceByteBudget !== false && metrics.differingBytes > budget.byteMax) {
    return { owner: 'final-capture', metric: 'bytes', actual: metrics.differingBytes, budget: budget.byteMax };
  }
  return null;
}

export function hasUnreasonablyWideBudget(budget: SceneCaseBudget): boolean {
  return budget.analyticMax > 1 || budget.roiMax > 1 || budget.byteMax > 255;
}
