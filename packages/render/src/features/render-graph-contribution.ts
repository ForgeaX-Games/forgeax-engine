import type {
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeaturePlanExecution } from './host';
import { RenderFeatureComputeGraphProjection } from './render-graph-compute';
import {
  type RenderFeatureGraphBindingsResolver,
  type RenderFeatureGraphTargetResolver,
  RenderFeatureRasterGraphProjection,
} from './render-graph-raster';
import { createRenderFeatureGraphBufferState } from './render-graph-resources';

/** Project the host-owned plan execution directly into the one typed graph. */
export function projectRenderFeaturePlans<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  executions: readonly RenderFeaturePlanExecution[],
  options: {
    readonly resolveTarget: RenderFeatureGraphTargetResolver;
    readonly resolveBindings?: RenderFeatureGraphBindingsResolver<FrameCtx> | undefined;
    readonly reportError?: ((error: RenderError) => void) | undefined;
  },
): Result<void, RenderGraphError | RenderError> {
  const buffers = createRenderFeatureGraphBufferState();
  const compute = new RenderFeatureComputeGraphProjection(builder, buffers, options.reportError);
  const raster = new RenderFeatureRasterGraphProjection(
    builder,
    options.resolveTarget,
    options.resolveBindings,
    buffers,
    options.reportError,
  );
  for (const execution of executions) {
    for (const pass of execution.passes) {
      if (pass.resolvedGpuCompute !== undefined) {
        const added = compute.addPass(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.resolvedGpuCompute,
        );
        if (!added.ok) return added;
        continue;
      }
      if (
        pass.graphics !== undefined &&
        pass.graphicsState !== undefined &&
        pass.resolvedGraphics !== undefined
      ) {
        const added = raster.addPass(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.graphics,
          pass.graphicsState,
          pass.resolvedGraphics,
        );
        if (!added.ok) return added;
        continue;
      }
      return err(
        new RenderFeatureStageFailedError(
          execution.featureIdentity,
          execution.order,
          'plan',
          'next-frame',
        ),
      );
    }
  }
  return ok(undefined);
}
