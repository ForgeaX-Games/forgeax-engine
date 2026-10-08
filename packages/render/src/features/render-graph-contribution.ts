import type {
  GraphAccess,
  GraphBufferAccess,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from './host';
import { RenderFeatureComputeGraphProjection } from './render-graph-compute';
import {
  type RenderFeatureGraphBindingsResolver,
  type RenderFeatureGraphTargetResolver,
  type RenderFeatureLightingResolver,
  RenderFeatureRasterGraphProjection,
  type RenderFeatureShadowDraws,
  resolveRenderFeatureDrawBuffers,
} from './render-graph-raster';
import { createRenderFeatureGraphBufferState } from './render-graph-resources';
import type { RenderFeaturePlacement } from './types';

export function createRenderFeatureProjectionState() {
  return {
    buffers: createRenderFeatureGraphBufferState(),
    projected: new Set<RenderFeaturePlanExecutionPass>(),
  };
}

function writesBuffer(access: GraphBufferAccess): boolean {
  switch (access) {
    case 'storage-write':
    case 'storage-read-write':
    case 'copy-dst':
      return true;
    case 'uniform-read':
    case 'storage-read':
    case 'indirect-read':
    case 'vertex-read':
    case 'index-read':
    case 'copy-src':
      return false;
  }
}

export function projectRenderFeatureShadows<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  executions: readonly RenderFeaturePlanExecution[],
  state: ReturnType<typeof createRenderFeatureProjectionState>,
): Result<RenderFeatureShadowDraws<FrameCtx> | undefined, RenderGraphError | RenderError> {
  if (!executions.some((execution) => execution.passes.some((pass) => pass.shadowCaster)))
    return ok(undefined);
  const compute = new RenderFeatureComputeGraphProjection(builder, state.buffers);
  const raster = new RenderFeatureRasterGraphProjection(
    builder,
    () => undefined,
    undefined,
    state.buffers,
  );
  const draws: RenderFeatureShadowDraws<FrameCtx>[] = [];
  // Hoist only work that can cross earlier deferred work without changing its
  // buffer observations. Physical identity catches aliases across features too.
  const deferredAccesses = new Set<Buffer>();
  const deferredWrites = new Set<Buffer>();
  for (const execution of executions) {
    for (const pass of execution.passes) {
      if (pass.graphics !== undefined && pass.resolvedGraphics !== undefined) {
        const inputs = resolveRenderFeatureDrawBuffers(
          execution.featureIdentity,
          execution.order,
          pass.graphics,
          pass.resolvedGraphics,
        );
        if (!inputs.ok) return inputs;
        for (const group of Object.values(inputs.value)) {
          for (const resource of group.values()) deferredAccesses.add(resource.buffer);
        }
      }
      if (pass.shadowCaster) {
        if (
          pass.graphics === undefined ||
          pass.graphicsState === undefined ||
          pass.resolvedGraphics === undefined
        )
          return err(
            new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
            ),
          );
        const prepared = raster.prepareShadowDraws(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.graphics,
          pass.graphicsState,
          pass.resolvedGraphics,
        );
        if (!prepared.ok) return prepared;
        draws.push(prepared.value);
        state.projected.add(pass);
        continue;
      }
      const work = pass.resolvedGpuCompute;
      if (work === undefined) continue;
      const canRunEarly =
        (work.sampledTargets?.length ?? 0) === 0 &&
        work.buffers.every(
          ({ buffer, access }) =>
            !deferredWrites.has(buffer) && (!writesBuffer(access) || !deferredAccesses.has(buffer)),
        );
      if (canRunEarly) {
        const added = compute.addPass(pass.name, execution.featureIdentity, execution.order, work);
        if (!added.ok) return added;
        state.projected.add(pass);
      } else {
        for (const { buffer, access } of work.buffers) {
          deferredAccesses.add(buffer);
          if (writesBuffer(access)) deferredWrites.add(buffer);
        }
      }
    }
  }
  return ok({
    accesses: draws.flatMap((draw) => [...draw.accesses]),
    encode: (pass, frame, resources, view) => {
      for (const draw of draws) draw.encode(pass, frame, resources, view);
    },
  });
}

/** Project the host-owned plan execution directly into the one typed graph. */
export function projectRenderFeaturePlans<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  executions: readonly RenderFeaturePlanExecution[],
  options: {
    readonly resolveTarget: RenderFeatureGraphTargetResolver;
    readonly resolveBindings?: RenderFeatureGraphBindingsResolver<FrameCtx> | undefined;
    readonly reportError?: ((error: RenderError) => void) | undefined;
    readonly resolveStandardLighting?: RenderFeatureLightingResolver<FrameCtx> | undefined;
    readonly standardSurfaceAccesses?: readonly GraphAccess[] | undefined;
    readonly viewAccesses?: readonly GraphAccess[] | undefined;
    /** Restrict projection to one Standard graph placement. */
    readonly placement?: RenderFeaturePlacement | undefined;
    /** Restrict projection to the named passes for a multi-stage feature. */
    readonly passNames?: ReadonlySet<string> | undefined;
    readonly state?: ReturnType<typeof createRenderFeatureProjectionState>;
  },
): Result<void, RenderGraphError | RenderError> {
  const state = options.state ?? createRenderFeatureProjectionState();
  const buffers = state.buffers;
  const compute = new RenderFeatureComputeGraphProjection(
    builder,
    buffers,
    options.reportError,
    options.resolveTarget,
  );
  const raster = new RenderFeatureRasterGraphProjection(
    builder,
    options.resolveTarget,
    options.resolveBindings,
    buffers,
    options.reportError,
    options.resolveStandardLighting,
    options.standardSurfaceAccesses,
    options.viewAccesses,
  );
  for (const execution of executions) {
    if (options.placement !== undefined && (execution.placement ?? 'post') !== options.placement) {
      continue;
    }
    for (const pass of execution.passes) {
      if (options.passNames !== undefined && !options.passNames.has(pass.name)) continue;
      if (state.projected.has(pass)) continue;
      if (pass.shadowCaster)
        return err(
          new RenderFeatureStageFailedError(
            execution.featureIdentity,
            execution.order,
            'plan',
            'next-frame',
          ),
        );
      if (pass.resolvedGpuCompute !== undefined) {
        const added = compute.addPass(
          pass.name,
          execution.featureIdentity,
          execution.order,
          pass.resolvedGpuCompute,
        );
        if (!added.ok) return added;
        state.projected.add(pass);
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
        state.projected.add(pass);
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
