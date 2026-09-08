import type {
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RasterDepthStencilAttachment,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { BindGroup, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type {
  PreparedGraphicsResolvedResource,
  PreparedGraphicsResolvedSnapshot,
} from '../prepare/prepared-graphics-resolver';
import type { RenderFeatureResolvedGpuBuffer } from './prepared-gpu-work';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from './prepared-graphics';
import { validateRenderFeatureGraphicsPass } from './prepared-graphics';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';
import type { RenderFeatureTargetHandle } from './targets';

export interface RenderFeatureGraphTarget {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
}

export type RenderFeatureGraphTargetResolver = (
  resource: string | RenderFeatureTargetHandle,
) => RenderFeatureGraphTarget | undefined;

export type RenderFeatureGraphBindingsResolution =
  | BindGroup
  | {
      readonly handle: BindGroup;
      readonly dynamicOffsets?: readonly number[];
    };

export type RenderFeatureGraphBindingsResolver<FrameCtx extends RenderGraphFrame> = (input: {
  readonly frame: FrameCtx;
  readonly binding: Extract<PreparedGraphicsResolvedResource, { readonly kind: 'bindings' }>;
  readonly resources: GraphResourceResolver;
  readonly resolveTarget: RenderFeatureGraphTargetResolver;
}) => RenderFeatureGraphBindingsResolution | undefined;

interface ResolvedDrawBuffers {
  readonly vertex: ReadonlyMap<object, GraphBuffer>;
  readonly index: ReadonlyMap<object, GraphBuffer>;
  readonly indirect: ReadonlyMap<object, GraphBuffer>;
}

function missing(featureIdentity: string, order: number): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(featureIdentity, order, 'record', 'renderer-recover');
}

function resolved(
  snapshot: PreparedGraphicsResolvedSnapshot,
  reference: RenderFeaturePreparedRef,
): PreparedGraphicsResolvedResource | undefined {
  return snapshot.resolve(reference);
}

export class RenderFeatureRasterGraphProjection<FrameCtx extends RenderGraphFrame> {
  private readonly buffers: RenderFeatureGraphBufferState;

  constructor(
    private readonly builder: RenderGraphBuilder<FrameCtx>,
    private readonly resolveTarget: RenderFeatureGraphTargetResolver,
    private readonly resolveBindings?: RenderFeatureGraphBindingsResolver<FrameCtx>,
    buffers?: RenderFeatureGraphBufferState,
    private readonly reportError?: (error: RenderError) => void,
  ) {
    this.buffers = buffers ?? createRenderFeatureGraphBufferState();
  }

  addPass(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    state: RenderFeaturePreparedGraphicsState,
    snapshot: PreparedGraphicsResolvedSnapshot,
  ): Result<void, RenderGraphError | RenderError> {
    const validated = validateRenderFeatureGraphicsPass(featureIdentity, descriptor, state);
    if (!validated.ok) return validated;

    const accesses = [];
    const colors = [];
    for (const attachment of descriptor.attachments.colors) {
      const target = this.resolveTarget(attachment.resource);
      if (target === undefined) return err(missing(featureIdentity, order));
      accesses.push({ resource: target.view, usage: 'color-attachment' } as const);
      colors.push({
        view: target.view,
        ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        loadOp: attachment.loadOp,
        storeOp: attachment.storeOp,
      });
    }

    let depthStencilAttachment: RasterDepthStencilAttachment | undefined;
    const depth = descriptor.attachments.depthStencil;
    if (depth !== undefined) {
      const target = this.resolveTarget(depth.resource);
      if (target === undefined) return err(missing(featureIdentity, order));
      const sampled = (descriptor.sampledTargets ?? []).some(
        (candidate) =>
          typeof depth.resource !== 'string' &&
          candidate.kind === depth.resource.kind &&
          candidate.format === depth.resource.format &&
          candidate.sampleCount === depth.resource.sampleCount,
      );
      accesses.push({
        resource: target.view,
        usage: sampled ? ('depth-stencil-read' as const) : ('depth-stencil-write' as const),
      });
      depthStencilAttachment = sampled
        ? { view: target.view, depthReadOnly: true, stencilReadOnly: true }
        : {
            view: target.view,
            depthLoadOp: depth.depthLoadOp,
            depthStoreOp: depth.depthStoreOp,
            stencilLoadOp: depth.depthLoadOp,
            stencilStoreOp: depth.depthStoreOp,
          };
    }

    for (const sampled of descriptor.sampledTargets ?? []) {
      const target = this.resolveTarget(sampled);
      if (target === undefined) return err(missing(featureIdentity, order));
      accesses.push({ resource: target.view, usage: 'sampled-read' } as const);
    }

    const drawBuffers = this.importDrawBuffers(name, featureIdentity, order, descriptor, snapshot);
    if (!drawBuffers.ok) return drawBuffers;
    for (const handle of drawBuffers.value.vertex.values()) {
      accesses.push({ resource: handle, usage: 'vertex-read' } as const);
    }
    for (const handle of drawBuffers.value.index.values()) {
      accesses.push({ resource: handle, usage: 'index-read' } as const);
    }
    for (const handle of drawBuffers.value.indirect.values()) {
      accesses.push({ resource: handle, usage: 'indirect-read' } as const);
    }

    return this.builder.addRasterPass(name, {
      accesses,
      colorAttachments: colors,
      ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
      encode: ({ pass, frame, resources }) => {
        try {
          this.encode(
            featureIdentity,
            order,
            descriptor,
            snapshot,
            drawBuffers.value,
            pass,
            frame,
            resources,
          );
        } catch (failure) {
          this.reportError?.(
            failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
              ? (failure as RenderError)
              : new RenderFeatureDrawRecordingFailedError(
                  featureIdentity,
                  order,
                  name,
                  'pipeline',
                  'backend-recording-failed',
                  failure instanceof Error ? failure.message : String(failure),
                  'renderer-recover',
                ),
          );
        }
      },
    });
  }

  private importDrawBuffers(
    name: string,
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    snapshot: PreparedGraphicsResolvedSnapshot,
  ): Result<ResolvedDrawBuffers, RenderGraphError | RenderError> {
    const vertex = new Map<object, GraphBuffer>();
    const index = new Map<object, GraphBuffer>();
    const indirect = new Map<object, GraphBuffer>();
    const add = (
      destination: Map<object, GraphBuffer>,
      key: object,
      resource: RenderFeatureResolvedGpuBuffer,
    ): Result<void, RenderGraphError> => {
      if (destination.has(key)) return ok(undefined);
      const imported = importRenderFeatureGraphBuffer(this.builder, this.buffers, name, resource);
      if (!imported.ok) return imported;
      destination.set(key, imported.value);
      return ok(undefined);
    };

    for (const draw of descriptor.draws) {
      for (const binding of draw.vertexData) {
        const resource = resolved(snapshot, binding.resource);
        if (resource?.kind !== 'vertex-data') return err(missing(featureIdentity, order));
        const added = add(vertex, binding.resource as object, {
          buffer: resource.handle,
          size: resource.size,
          physicalUsage: resource.physicalUsage,
        });
        if (!added.ok) return added;
      }
      if (draw.indexData !== undefined) {
        const resource = resolved(snapshot, draw.indexData.resource);
        if (resource?.kind !== 'index-data') return err(missing(featureIdentity, order));
        const added = add(index, draw.indexData.resource as object, {
          buffer: resource.handle,
          size: resource.size,
          physicalUsage: resource.physicalUsage,
        });
        if (!added.ok) return added;
      }
      if (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') {
        const resource = snapshot.resolveGpuBuffer?.(draw.command.buffer);
        if (resource === undefined) return err(missing(featureIdentity, order));
        const added = add(indirect, draw.command.buffer as object, resource);
        if (!added.ok) return added;
      }
    }
    return ok({ vertex, index, indirect });
  }

  private encode(
    featureIdentity: string,
    order: number,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    snapshot: PreparedGraphicsResolvedSnapshot,
    buffers: ResolvedDrawBuffers,
    pass: RhiRenderPassEncoder,
    frame: FrameCtx,
    resources: GraphResourceResolver,
  ): void {
    for (const draw of descriptor.draws) {
      const pipeline = resolved(snapshot, draw.pipeline);
      if (pipeline?.kind !== 'pipeline') throw missing(featureIdentity, order);
      pass.setPipeline(pipeline.handle);
      for (const [group, reference] of draw.bindings.entries()) {
        const binding = resolved(snapshot, reference);
        if (binding?.kind !== 'bindings') throw missing(featureIdentity, order);
        const resolvedBindings =
          binding.handle ??
          this.resolveBindings?.({ frame, binding, resources, resolveTarget: this.resolveTarget });
        const handle =
          resolvedBindings !== undefined &&
          typeof resolvedBindings === 'object' &&
          'handle' in resolvedBindings
            ? resolvedBindings.handle
            : resolvedBindings;
        if (handle === undefined) throw missing(featureIdentity, order);
        const targetGroup = binding.descriptor?.values.group ?? group;
        const dynamicOffsets =
          resolvedBindings !== undefined &&
          typeof resolvedBindings === 'object' &&
          'handle' in resolvedBindings
            ? resolvedBindings.dynamicOffsets
            : binding.dynamicOffsets;
        pass.setBindGroup(targetGroup, handle, dynamicOffsets);
      }
      for (const vertex of draw.vertexData) {
        const handle = buffers.vertex.get(vertex.resource as object);
        if (handle === undefined) throw missing(featureIdentity, order);
        const physical = resources.buffer(handle);
        if (!physical.ok) throw physical.error;
        pass.setVertexBuffer(vertex.slot, physical.value);
      }
      if (draw.indexData !== undefined) {
        const handle = buffers.index.get(draw.indexData.resource as object);
        if (handle === undefined) throw missing(featureIdentity, order);
        const physical = resources.buffer(handle);
        if (!physical.ok) throw physical.error;
        pass.setIndexBuffer(physical.value, draw.indexData.format);
      }
      switch (draw.kind) {
        case 'draw':
          pass.draw(
            draw.command.vertexCount,
            draw.command.instanceCount,
            draw.command.firstVertex,
            draw.command.firstInstance,
          );
          break;
        case 'draw-indexed':
          pass.drawIndexed(
            draw.command.indexCount,
            draw.command.instanceCount,
            draw.command.firstIndex,
            draw.command.baseVertex,
            draw.command.firstInstance,
          );
          break;
        case 'draw-indirect':
        case 'draw-indexed-indirect': {
          const handle = buffers.indirect.get(draw.command.buffer as object);
          if (handle === undefined) throw missing(featureIdentity, order);
          const physical = resources.buffer(handle);
          if (!physical.ok) throw physical.error;
          if (draw.kind === 'draw-indirect') {
            pass.drawIndirect(physical.value, draw.command.offset ?? 0);
          } else {
            pass.drawIndexedIndirect(physical.value, draw.command.offset ?? 0);
          }
          break;
        }
      }
    }
  }
}
