import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  CommandBuffer,
  ComputePipeline,
  PipelineLayout,
  RenderPipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { ResourceKind } from '../protocol/types';

export type ReplayResource = {
  readonly role?: string;
} & (
  | { readonly kind: 'buffer'; readonly value: Buffer }
  | { readonly kind: 'texture'; readonly value: Texture }
  | { readonly kind: 'texture-view'; readonly value: TextureView }
  | { readonly kind: 'sampler'; readonly value: Sampler }
  | { readonly kind: 'shader-module'; readonly value: ShaderModule }
  | {
      readonly kind: 'pipeline';
      readonly role: 'render' | 'compute';
      readonly value: RenderPipeline | ComputePipeline;
    }
  | {
      readonly kind: 'binding';
      readonly role: 'bind-group' | 'bind-group-layout' | 'pipeline-layout';
      readonly value: BindGroup | BindGroupLayout | PipelineLayout;
    }
  | {
      readonly kind: 'encoder';
      readonly role: 'command' | 'command-buffer' | 'render-pass' | 'compute-pass';
      readonly value:
        | RhiCommandEncoder
        | RhiRenderPassEncoder
        | RhiComputePassEncoder
        | CommandBuffer;
    }
);

export interface ResourceTableEntry {
  readonly resourceId: string;
  readonly generation: number;
  readonly resource: ReplayResource;
  readonly descriptor: Record<string, unknown> | undefined;
}

export class ResourceTable {
  private readonly entries = new Map<string, ResourceTableEntry>();
  private disposed = false;
  private currentGeneration: number;

  constructor(
    private readonly device: RhiDevice,
    generation = 0,
  ) {
    this.currentGeneration = generation;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get(resourceId: string): ResourceTableEntry | undefined {
    return this.entries.get(resourceId);
  }

  set(
    resourceId: string,
    resource: ReplayResource,
    descriptor?: Record<string, unknown> | undefined,
  ): Result<void, RhiDebugError> {
    if (this.disposed) {
      return err(
        createRhiDebugError('replay-position-invalid', {
          requested: this.generation,
          available: -1,
        }),
      );
    }
    this.entries.set(resourceId, {
      resourceId,
      generation: this.generation,
      resource,
      descriptor,
    });
    return ok(undefined);
  }

  delete(resourceId: string): void {
    this.entries.delete(resourceId);
  }

  values(): IterableIterator<ResourceTableEntry> {
    return this.entries.values();
  }

  reset(): Result<void, RhiDebugError> {
    const result = this.releaseAll();
    if (!result.ok) return result;
    this.entries.clear();
    this.currentGeneration += 1;
    return ok(undefined);
  }

  dispose(): Result<void, RhiDebugError> {
    if (this.disposed) return ok(undefined);
    const result = this.releaseAll();
    this.entries.clear();
    this.disposed = true;
    return result;
  }

  private releaseAll(): Result<void, RhiDebugError> {
    let firstFailure: Result<never, RhiDebugError> | undefined;
    for (const entry of this.entries.values()) {
      if (entry.resource.kind === 'buffer') {
        const result = this.device.destroyBuffer(entry.resource.value);
        if (!result.ok && firstFailure === undefined)
          firstFailure = resourceDisposeFailure(entry.resourceId, result.error.code);
      } else if (entry.resource.kind === 'texture') {
        const result = this.device.destroyTexture(entry.resource.value);
        if (!result.ok && firstFailure === undefined)
          firstFailure = resourceDisposeFailure(entry.resourceId, result.error.code);
      }
    }
    return firstFailure ?? ok(undefined);
  }
}

function resourceDisposeFailure(resourceId: string, cause: string): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-event-failed', {
      eventIndex: -1,
      kind: `dispose:${resourceId}`,
      stage: 'create',
      cause,
    }),
  );
}

export function isResourceKind(resource: ReplayResource, kind: ResourceKind): boolean {
  return resource.kind === kind;
}
