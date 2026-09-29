import type {
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { err, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type { RenderFeatureComputeTarget } from './prepared-gpu-work';
import {
  encodeRenderFeatureGpuComputePass,
  type RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import type { RenderFeatureGraphTargetResolver } from './render-graph-raster';
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
    private readonly resolveTarget?: RenderFeatureGraphTargetResolver,
  ) {
    this.resources = resources ?? createRenderFeatureGraphBufferState();
  }

  addPass(
    name: string,
    featureIdentity: string,
    order: number,
    work: RenderFeatureResolvedGpuComputePass,
  ): Result<void, RenderGraphError | RenderError> {
    const accesses = [];
    const targets = new Map<
      RenderFeatureComputeTarget,
      NonNullable<ReturnType<RenderFeatureGraphTargetResolver>>
    >();
    const sampledTargets = new Set(work.sampledTargets ?? []);
    const storageTargets = new Set(work.storageTargets ?? []);
    for (const handle of [...sampledTargets, ...storageTargets]) {
      let target = this.resolveTarget?.(handle);
      if (target === undefined)
        return err(
          new RenderFeatureStageFailedError(featureIdentity, order, 'record', 'renderer-recover'),
        );
      if (typeof handle !== 'string' && handle.kind === 'scene-depth') {
        const view = this.builder.view(target.texture, { aspect: 'depth-only' });
        if (!view.ok) return view;
        target = { ...target, view: view.value };
      }
      targets.set(handle, target);
      if (sampledTargets.has(handle) && storageTargets.has(handle)) {
        accesses.push({ resource: target.view, usage: 'sampled-storage-read-write' as const });
      } else if (storageTargets.has(handle)) {
        accesses.push({ resource: target.view, usage: 'storage-write' as const });
      } else {
        accesses.push({ resource: target.view, usage: 'sampled-read' as const });
      }
    }
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
      encode: ({ pass, resources }) => {
        try {
          encodeRenderFeatureGpuComputePass(pass, work, (name) => {
            const target = targets.get(name);
            if (target === undefined) throw new Error(`Missing sampled graph target: ${name}`);
            const view = resources.textureView(target.view);
            if (!view.ok) throw view.error;
            return view.value;
          });
        } catch (failure) {
          const error =
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
                );
          this.reportError?.(error);
          // A partially encoded intent is not a submitted transaction.
          throw error;
        }
      },
    });
  }
}
