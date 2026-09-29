import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from './host';

/** The accepted plan for this submission, independent of cached graph topology. */
export interface RenderFeatureExecutionFrame extends RenderGraphFrame {
  readonly featureExecutions?: readonly RenderFeaturePlanExecution[];
}

export function currentRenderFeaturePass(
  frame: RenderGraphFrame,
  featureIdentity: string,
  passName: string,
): RenderFeaturePlanExecutionPass | undefined {
  const executions = (frame as RenderFeatureExecutionFrame).featureExecutions;
  return executions
    ?.find((execution) => execution.featureIdentity === featureIdentity)
    ?.passes.find((pass) => pass.name === passName);
}
