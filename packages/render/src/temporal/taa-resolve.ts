import type { RenderPipelineFeatureTarget, RenderPipelineTarget } from '../render-pipeline';

export interface TaaResolveInput {
  readonly current: RenderPipelineFeatureTarget;
  readonly temporal: RenderPipelineFeatureTarget;
  readonly historyValid: boolean;
}

export interface TaaResolveInspection {
  readonly applied: boolean;
  readonly currentOnly: boolean;
  readonly historyGeneration: number;
}

/** TAA resolve contract; graph encoding remains owned by Standard topology. */
export function resolveTaa(
  input: TaaResolveInput,
  historyGeneration: number,
): TaaResolveInspection {
  return {
    applied: input.historyValid,
    currentOnly: !input.historyValid,
    historyGeneration,
  };
}

export function taaOutputTarget(target: RenderPipelineFeatureTarget): RenderPipelineTarget {
  return {
    texture: target.texture,
    view: target.view,
    format: 'rgba16float',
    sampleCount: 1,
  };
}
