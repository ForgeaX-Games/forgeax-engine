import type {
  Buffer,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RhiComputePassEncoder,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import type {
  CompiledPass,
  CompiledResource,
  CompiledView,
  ResourceHandleData,
} from './kernel-internal.js';
import { handleData } from './kernel-internal.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RenderGraphFrame,
  RenderGraphPassRunner,
} from './types.js';

interface FrameResources {
  readonly buffers: ReadonlyMap<number, Buffer>;
  readonly textures: ReadonlyMap<number, Texture>;
  readonly views: ReadonlyMap<number, TextureView>;
}

function resolutionError(label: string, cause?: unknown): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: `resource '${label}' resolves to a live RHI handle for this frame`,
    hint: `repair the imported owner for '${label}' before executing the graph`,
    detail: { resourceLabel: label, ...(cause === undefined ? {} : { accesses: [String(cause)] }) },
  });
}

export class CompiledRenderGraphImpl<FrameCtx extends RenderGraphFrame>
  implements CompiledRenderGraph<FrameCtx>
{
  private retired = false;
  private retireResult: Promise<Result<void, RenderGraphError>> | undefined;

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly resources: ReadonlyMap<number, CompiledResource<FrameCtx>>,
    private readonly views: ReadonlyMap<number, CompiledView<FrameCtx>>,
    private readonly passes: readonly CompiledPass<FrameCtx>[],
    private readonly info: CompiledRenderGraphInfo,
  ) {}

  inspect(): CompiledRenderGraphInfo {
    return this.info;
  }

  execute(frame: FrameCtx, runPass?: RenderGraphPassRunner): Result<void, RenderGraphError> {
    if (this.retired) {
      return err(
        new RenderGraphError({
          code: 'compiled-graph-retired',
          expected: 'a compiled graph executes only before retire()',
          hint: 'publish and execute the replacement compiled graph',
          detail: { generation: this.generation },
        }),
      );
    }

    const resolved = this.resolveFrameResources(frame);
    if (!resolved.ok) return resolved;

    for (const [executionIndex, pass] of this.passes.entries()) {
      const resolver = this.createPassResolver(pass, resolved.value);
      try {
        if (pass.pass.descriptor.executeIf?.(frame) === false) continue;
        let encodeResult: Result<void, RenderGraphError> = ok(undefined);
        const encode = () => {
          switch (pass.pass.kind) {
            case 'raster': {
              const descriptor = pass.pass.descriptor;
              const colorAttachments: RenderPassColorAttachment[] = [];
              for (const attachment of descriptor.colorAttachments) {
                const view = resolver.textureView(attachment.view);
                if (!view.ok) {
                  encodeResult = view;
                  return;
                }
                const resolveTarget =
                  attachment.resolveTarget === undefined
                    ? undefined
                    : resolver.textureView(attachment.resolveTarget);
                if (resolveTarget !== undefined && !resolveTarget.ok) {
                  encodeResult = resolveTarget;
                  return;
                }
                const clearValue =
                  typeof attachment.clearValue === 'function'
                    ? attachment.clearValue(frame)
                    : attachment.clearValue;
                colorAttachments.push({
                  view: view.value,
                  ...(resolveTarget === undefined ? {} : { resolveTarget: resolveTarget.value }),
                  ...(clearValue === undefined ? {} : { clearValue }),
                  loadOp: attachment.loadOp,
                  storeOp: attachment.storeOp,
                  ...(attachment.depthSlice === undefined
                    ? {}
                    : { depthSlice: attachment.depthSlice }),
                });
              }
              let depthStencilAttachment: RenderPassDepthStencilAttachment | undefined;
              if (descriptor.depthStencilAttachment !== undefined) {
                const attachment = descriptor.depthStencilAttachment;
                const view = resolver.textureView(attachment.view);
                if (!view.ok) {
                  encodeResult = view;
                  return;
                }
                depthStencilAttachment = {
                  view: view.value,
                  ...(attachment.depthClearValue === undefined
                    ? {}
                    : { depthClearValue: attachment.depthClearValue }),
                  ...(attachment.depthLoadOp === undefined
                    ? {}
                    : { depthLoadOp: attachment.depthLoadOp }),
                  ...(attachment.depthStoreOp === undefined
                    ? {}
                    : { depthStoreOp: attachment.depthStoreOp }),
                  ...(attachment.depthReadOnly === undefined
                    ? {}
                    : { depthReadOnly: attachment.depthReadOnly }),
                  ...(attachment.stencilClearValue === undefined
                    ? {}
                    : { stencilClearValue: attachment.stencilClearValue }),
                  ...(attachment.stencilLoadOp === undefined
                    ? {}
                    : { stencilLoadOp: attachment.stencilLoadOp }),
                  ...(attachment.stencilStoreOp === undefined
                    ? {}
                    : { stencilStoreOp: attachment.stencilStoreOp }),
                  ...(attachment.stencilReadOnly === undefined
                    ? {}
                    : { stencilReadOnly: attachment.stencilReadOnly }),
                };
              }
              const encoder = frame.encoder.beginRenderPass({
                label: pass.name,
                colorAttachments,
                ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
              });
              try {
                descriptor.encode({ pass: encoder, frame, resources: resolver });
              } finally {
                encoder.end();
              }
              break;
            }
            case 'compute': {
              const begin = pass.pass.descriptor.begin?.(frame);
              let encoder: RhiComputePassEncoder;
              try {
                encoder = frame.encoder.beginComputePass({ ...(begin ?? {}), label: pass.name });
              } catch (cause) {
                pass.pass.descriptor.onBeginError?.(frame, cause);
                throw cause;
              }
              try {
                pass.pass.descriptor.encode({ pass: encoder, frame, resources: resolver });
              } finally {
                encoder.end();
              }
              pass.pass.descriptor.after?.(frame);
              break;
            }
            case 'copy':
              pass.pass.descriptor.encode({ encoder: frame.encoder, frame, resources: resolver });
              break;
          }
        };
        if (runPass === undefined) {
          encode();
        } else {
          runPass({ name: pass.name, kind: pass.pass.kind, executionIndex }, encode);
        }
        if (!encodeResult.ok) return encodeResult;
      } catch (cause) {
        return err(
          new RenderGraphError({
            code: 'pass-encode-failed',
            expected: `pass '${pass.name}' encodes without throwing`,
            hint: 'inspect detail.cause and repair the pass-owned RHI command',
            detail: { passName: pass.name, passKind: pass.pass.kind, cause },
          }),
        );
      }
    }
    return ok(undefined);
  }

  retire(): Promise<Result<void, RenderGraphError>> {
    if (this.retireResult !== undefined) return this.retireResult;
    this.retired = true;
    this.retireResult = this.finishRetire();
    return this.retireResult;
  }

  private async finishRetire(): Promise<Result<void, RenderGraphError>> {
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch (cause) {
      return err(
        new RenderGraphError({
          code: 'resource-retire-failed',
          expected: 'the GPU submission fence resolves before graph resources retire',
          hint: 'recover the device before retiring the replacement generation',
          detail: { generation: this.generation, cause },
        }),
      );
    }

    let firstFailure: RenderGraphError | undefined;
    for (const compiled of this.resources.values()) {
      if (compiled.record.origin === 'imported') continue;
      if (compiled.texture === undefined && compiled.buffer === undefined) continue;
      try {
        const destroyed =
          compiled.record.kind === 'texture'
            ? this.device.destroyTexture(compiled.texture as Texture)
            : this.device.destroyBuffer(compiled.buffer as Buffer);
        if (!destroyed.ok && firstFailure === undefined) {
          firstFailure = new RenderGraphError({
            code: 'resource-retire-failed',
            expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
            hint: 'inspect detail.cause for the RHI destroy refusal',
            detail: {
              generation: this.generation,
              resourceLabel: compiled.record.label,
              cause: destroyed.error,
            },
          });
        }
      } catch (cause) {
        firstFailure ??= new RenderGraphError({
          code: 'resource-retire-failed',
          expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
          hint: 'inspect detail.cause for the RHI destroy failure',
          detail: { generation: this.generation, resourceLabel: compiled.record.label, cause },
        });
      }
    }
    return firstFailure === undefined ? ok(undefined) : err(firstFailure);
  }

  private resolveFrameResources(frame: FrameCtx): Result<FrameResources, RenderGraphError> {
    const buffers = new Map<number, Buffer>();
    const textures = new Map<number, Texture>();
    const views = new Map<number, TextureView>();

    for (const compiled of this.resources.values()) {
      if (compiled.usage === 0) continue;
      try {
        if (compiled.record.kind === 'texture') {
          const texture =
            compiled.record.origin === 'created'
              ? compiled.texture
              : compiled.record.resolve(frame);
          if (texture === undefined) return err(resolutionError(compiled.record.label));
          textures.set(compiled.record.id, texture);
        } else {
          const buffer =
            compiled.record.origin === 'created' ? compiled.buffer : compiled.record.resolve(frame);
          if (buffer === undefined) return err(resolutionError(compiled.record.label));
          buffers.set(compiled.record.id, buffer);
        }
      } catch (cause) {
        return err(resolutionError(compiled.record.label, cause));
      }
    }

    for (const compiledView of this.views.values()) {
      if (this.resources.get(compiledView.record.textureId)?.usage === 0) continue;
      if (compiledView.record.resolve !== undefined) {
        try {
          views.set(compiledView.record.id, compiledView.record.resolve(frame));
        } catch (cause) {
          return err(resolutionError(compiledView.record.label, cause));
        }
        continue;
      }
      if (compiledView.view !== undefined) {
        views.set(compiledView.record.id, compiledView.view);
        continue;
      }
      const texture = textures.get(compiledView.record.textureId);
      if (texture === undefined) return err(resolutionError(compiledView.record.label));
      const created = this.device.createTextureView(texture, compiledView.record.descriptor);
      if (!created.ok) return err(resolutionError(compiledView.record.label, created.error));
      views.set(compiledView.record.id, created.value);
    }
    return ok({ buffers, textures, views });
  }

  private createPassResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    const lookup = (
      resource: GraphBuffer | GraphTexture | GraphTextureView,
      expectedKind: ResourceHandleData['kind'],
    ): Result<ResourceHandleData, RenderGraphError> => {
      const data = handleData(resource);
      const resourceId = data?.kind === 'texture-view' ? data.textureId : data?.id;
      if (data === undefined || data.owner !== this.owner || data.kind !== expectedKind) {
        return err(
          new RenderGraphError({
            code: 'foreign-resource-handle',
            expected: `pass '${pass.name}' resolves a handle owned by this compiled graph`,
            hint: 'use only handles created by the builder that declared this pass',
            detail: { passName: pass.name },
          }),
        );
      }
      if (resourceId === undefined || !pass.resourceIds.has(resourceId)) {
        const label = this.resources.get(resourceId ?? -1)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only resources present in its accesses`,
            hint: 'add the resource access to this pass before resolving it',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      if (data.kind === 'texture-view' && !pass.viewIds.has(data.id)) {
        const label = this.views.get(data.id)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only texture views present in its accesses`,
            hint: 'add this exact texture view to the pass accesses',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      return ok(data);
    };

    return {
      buffer: (resource) => {
        const data = lookup(resource, 'buffer');
        if (!data.ok) return data;
        const buffer = frameResources.buffers.get(data.value.id);
        return buffer === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'buffer'))
          : ok(buffer);
      },
      texture: (resource) => {
        const data = lookup(resource, 'texture');
        if (!data.ok) return data;
        const texture = frameResources.textures.get(data.value.id);
        return texture === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'texture'))
          : ok(texture);
      },
      textureView: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        const view = frameResources.views.get(data.value.id);
        return view === undefined
          ? err(resolutionError(this.views.get(data.value.id)?.record.label ?? 'texture view'))
          : ok(view);
      },
    };
  }
}
