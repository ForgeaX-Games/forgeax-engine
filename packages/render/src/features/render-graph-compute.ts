import type {
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureDrawRecordingFailedError } from '../errors/render';
import {
  encodeRenderFeatureGpuComputePass,
  type RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';

export class RenderFeatureComputeGraphProjection<FrameCtx extends RenderGraphFrame> {
  private readonly resources: RenderFeatureGraphBufferState;

  constructor(
    private readonly builder: RenderGraphBuilder<FrameCtx>,
    resources?: RenderFeatureGraphBufferState,
    private readonly reportError?: (error: RenderError) => void,
  ) {
    this.resources = resources ?? createRenderFeatureGraphBufferState();
  }

  addPass(
    name: string,
    featureIdentity: string,
    order: number,
    work: RenderFeatureResolvedGpuComputePass,
  ): Result<void, RenderGraphError> {
    const accesses = [];
    for (const resource of work.buffers) {
      const imported = importRenderFeatureGraphBuffer(
        this.builder,
        this.resources,
        `${name}.${resource.name}`,
        resource,
      );
      if (!imported.ok) return imported;
      accesses.push({ resource: imported.value, usage: resource.access } as const);
    }
    return this.builder.addComputePass(name, {
      accesses,
      encode: ({ pass }) => {
        try {
          encodeRenderFeatureGpuComputePass(pass, work);
        } catch (failure) {
          this.reportError?.(
            failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
              ? (failure as RenderError)
              : new RenderFeatureDrawRecordingFailedError(
                  featureIdentity,
                  order,
                  name,
                  'bindings',
                  'backend-recording-failed',
                  failure instanceof Error ? failure.message : String(failure),
                  'renderer-recover',
                ),
          );
        }
      },
    });
  }
}
