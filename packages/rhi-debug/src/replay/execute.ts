import type {
  BindGroupDescriptor,
  Buffer,
  CommandBuffer,
  PipelineLayout,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RhiBindingResource,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiQueue,
  Texture,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { RhiCallEvent, Tape } from '../protocol/types';
import {
  blob,
  clearBuffer,
  commandEncoderCall,
  endPass,
  eventFailure,
  eventRecord,
  finish,
  missingResource,
  passCall,
  pipelineError,
  requireReplayResource,
  requireResource,
  seedInitialData,
  unsupportedEvent,
} from './execute-support';
import type { ReplayResource, ResourceTable } from './resources';
import { isDepthTextureFormat } from './texture-format';

export { eventFailure } from './execute-support';

export interface ReplayExecutionContext {
  readonly device: RhiDevice;
  readonly queue: RhiQueue;
  readonly tape: Tape;
  readonly table: ResourceTable;
  readonly createShaderModule: (
    device: RhiDevice,
    desc: { readonly code: string; readonly label?: string | undefined },
  ) => Promise<Result<import('@forgeax/engine-rhi').ShaderModule, RhiError>>;
}

export async function executeEvent(
  context: ReplayExecutionContext,
  event: RhiCallEvent,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  try {
    switch (event.kind) {
      case 'frameMark':
        return ok(undefined);
      case 'createBuffer':
        return createResource(context, eventIndex, event, context.device.createBuffer(event.desc), {
          kind: 'buffer',
        });
      case 'createTexture':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createTexture(replayTextureDescriptor(event.desc) as never),
          {
            kind: 'texture',
          },
        );
      case 'destroyBuffer':
        return destroyResource(context, eventIndex, event, 'buffer');
      case 'destroyTexture':
        return destroyResource(context, eventIndex, event, 'texture');
      case 'createTextureView': {
        const texture = requireResource<Texture>(
          context,
          event.sourceHandleId,
          'texture',
          eventIndex,
          event.kind,
        );
        if (!texture.ok) return texture;
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createTextureView(texture.value, event.desc),
          { kind: 'texture-view' },
          event.resultHandleId,
        );
      }
      case 'createSampler':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createSampler(event.desc),
          {
            kind: 'sampler',
          },
        );
      case 'createBindGroupLayout':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createBindGroupLayout(event.desc as never),
          { kind: 'binding', role: 'bind-group-layout' },
        );
      case 'createBindGroup':
        return createBindGroup(context, event, eventIndex);
      case 'createPipelineLayout':
        return createPipelineLayout(context, event, eventIndex);
      case 'createRenderPipeline':
        return createRenderPipeline(context, event, eventIndex);
      case 'createComputePipeline':
        return createComputePipeline(context, event, eventIndex);
      case 'createShaderModule':
        return createShaderModule(context, event, eventIndex);
      case 'createCommandEncoder':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createCommandEncoder(event.desc),
          { kind: 'encoder', role: 'command' },
          event.cmdHandleId,
        );
      case 'writeBuffer':
        return writeBuffer(context, event, eventIndex);
      case 'writeTexture':
        return writeTexture(context, event, eventIndex);
      case 'copyExternalImageToTexture':
        return unsupportedEvent(eventIndex, event, 'external image sources are not self-contained');
      case 'submit':
        return submit(context, event, eventIndex);
      case 'beginRenderPass':
        return beginRenderPass(context, event, eventIndex);
      case 'beginComputePass':
        return beginComputePass(context, event, eventIndex);
      case 'copyBufferToBuffer':
        return copyBufferToBuffer(context, event, eventIndex);
      case 'copyBufferToTexture':
        return copyBufferToTexture(context, event, eventIndex);
      case 'copyTextureToBuffer':
        return copyTextureToBuffer(context, event, eventIndex);
      case 'copyTextureToTexture':
        return copyTextureToTexture(context, event, eventIndex);
      case 'clearBuffer':
        return clearBuffer(context, event, eventIndex);
      case 'pushDebugGroup':
        return commandEncoderCall(context, event, eventIndex, (encoder) =>
          encoder.pushDebugGroup(event.groupLabel),
        );
      case 'popDebugGroup':
        return commandEncoderCall(context, event, eventIndex, (encoder) => encoder.popDebugGroup());
      case 'insertDebugMarker':
        return commandEncoderCall(context, event, eventIndex, (encoder) =>
          encoder.insertDebugMarker(event.markerLabel),
        );
      case 'finish':
        return finish(context, event, eventIndex);
      case 'setPipeline':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const pipeline = requireReplayResource(
            context,
            event.pipelineHandleId,
            'pipeline',
            eventIndex,
            event.kind,
          );
          if (!pipeline.ok || pipeline.value.role !== 'render')
            return pipelineError(pipeline, event, eventIndex);
          pass.setPipeline(pipeline.value.value as never);
          return ok(undefined);
        });
      case 'setVertexBuffer':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource<Buffer>(
            context,
            event.bufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.setVertexBuffer(event.slot, buffer.value, event.offset, event.size);
          return ok(undefined);
        });
      case 'setIndexBuffer':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource<Buffer>(
            context,
            event.bufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.setIndexBuffer(buffer.value, event.format, event.offset, event.size);
          return ok(undefined);
        });
      case 'setBindGroup':
        return passCall(context, event, eventIndex, 'pass', (pass) => {
          const bindGroup = requireReplayResource(
            context,
            event.bindGroupHandleId,
            'binding',
            eventIndex,
            event.kind,
          );
          if (!bindGroup.ok || bindGroup.value.role !== 'bind-group')
            return pipelineError(bindGroup, event, eventIndex);
          pass.setBindGroup(event.index, bindGroup.value.value as never, event.dynamicOffsets);
          return ok(undefined);
        });
      case 'draw':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.draw(event.vertexCount, event.instanceCount, event.firstVertex, event.firstInstance);
          return ok(undefined);
        });
      case 'drawIndexed':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.drawIndexed(
            event.indexCount,
            event.instanceCount,
            event.firstIndex,
            event.baseVertex,
            event.firstInstance,
          );
          return ok(undefined);
        });
      case 'setViewport':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setViewport(event.x, event.y, event.w, event.h, event.minDepth, event.maxDepth);
          return ok(undefined);
        });
      case 'setScissorRect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setScissorRect(event.x, event.y, event.w, event.h);
          return ok(undefined);
        });
      case 'setStencilReference':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setStencilReference(event.reference);
          return ok(undefined);
        });
      case 'endRenderPass':
        return endPass(context, event, eventIndex, 'render-pass');
      case 'setBlendConstant':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setBlendConstant(event.color);
          return ok(undefined);
        });
      case 'drawIndirect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource<Buffer>(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.drawIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'drawIndexedIndirect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource<Buffer>(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.drawIndexedIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'passPushDebugGroup':
        return passCall(context, event, eventIndex, 'pass', (pass) => {
          pass.pushDebugGroup(event.groupLabel);
          return ok(undefined);
        });
      case 'passPopDebugGroup':
        return passCall(context, event, eventIndex, 'pass', (pass) => {
          pass.popDebugGroup();
          return ok(undefined);
        });
      case 'passInsertDebugMarker':
        return passCall(context, event, eventIndex, 'pass', (pass) => {
          pass.insertDebugMarker(event.markerLabel);
          return ok(undefined);
        });
      case 'setComputePipeline':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          const pipeline = requireReplayResource(
            context,
            event.pipelineHandleId,
            'pipeline',
            eventIndex,
            event.kind,
          );
          if (!pipeline.ok || pipeline.value.role !== 'compute')
            return pipelineError(pipeline, event, eventIndex);
          pass.setPipeline(pipeline.value.value as never);
          return ok(undefined);
        });
      case 'dispatchWorkgroups':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          pass.dispatchWorkgroups(event.x, event.y, event.z);
          return ok(undefined);
        });
      case 'dispatchWorkgroupsIndirect':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          const buffer = requireResource<Buffer>(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.dispatchWorkgroupsIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'endComputePass':
        return endPass(context, event, eventIndex, 'compute-pass');
      case 'initialData':
        return seedInitialData(context, event, eventIndex);
      default:
        return unsupportedEvent(eventIndex, event, 'event kind has no replay executor');
    }
  } catch (cause) {
    return eventFailure(eventIndex, event, 'encode', cause);
  }
}

function replayTextureDescriptor(
  descriptor: Extract<RhiCallEvent, { kind: 'createTexture' }>['desc'],
): Extract<RhiCallEvent, { kind: 'createTexture' }>['desc'] {
  if (!isDepthTextureFormat(descriptor.format)) return descriptor;
  return {
    ...descriptor,
    // depth24plus* readback uses a package-owned depth-to-color blit and thus
    // needs the source texture to be bindable on a fresh replay device.
    usage: (descriptor.usage ?? 0) | 0x04,
  };
}

function createResource<T extends ReplayResource>(
  context: ReplayExecutionContext,
  eventIndex: number,
  event: RhiCallEvent,
  result: Result<T['value'], RhiError>,
  shape: Pick<ReplayResource, 'kind'> & { readonly role?: string },
  resourceId?: string,
): Result<void, RhiDebugError> {
  if (!result.ok) return eventFailure(eventIndex, event, 'create', result.error);
  const id = resourceId ?? ('handleId' in event ? event.handleId : undefined);
  if (id === undefined)
    return eventFailure(eventIndex, event, 'lookup', 'created resource has no handle id');
  const stored = context.table.set(id, { ...shape, value: result.value } as T, eventRecord(event));
  return stored.ok ? ok(undefined) : stored;
}

function destroyResource(
  context: ReplayExecutionContext,
  eventIndex: number,
  event: Extract<RhiCallEvent, { kind: 'destroyBuffer' | 'destroyTexture' }>,
  kind: 'buffer' | 'texture',
): Result<void, RhiDebugError> {
  const entry = context.table.get(event.handleId);
  if (entry === undefined || entry.resource.kind !== kind)
    return missingResource(eventIndex, event, event.handleId, kind);
  const result =
    kind === 'buffer'
      ? context.device.destroyBuffer(entry.resource.value as Buffer)
      : context.device.destroyTexture(entry.resource.value as Texture);
  if (!result.ok) return eventFailure(eventIndex, event, 'create', result.error);
  context.table.delete(event.handleId);
  return ok(undefined);
}

async function createShaderModule(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createShaderModule' }>,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const result = await context.createShaderModule(context.device, { code: event.wgslCode });
  return createResource(context, eventIndex, event, result, { kind: 'shader-module' });
}

function createBindGroup(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createBindGroup' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = requireReplayResource(
    context,
    event.layoutHandleId,
    'binding',
    eventIndex,
    event.kind,
  );
  if (!layout.ok || layout.value.role !== 'bind-group-layout')
    return pipelineError(layout, event, eventIndex);
  const resources: RhiBindingResource[] = [];
  for (const [index, entry] of event.entries.entries()) {
    const resourceId = event.resourceHandleIds[index];
    if (resourceId === undefined)
      return eventFailure(eventIndex, event, 'lookup', 'bind group resource handle is missing');
    const resolved = context.table.get(resourceId);
    if (resolved === undefined)
      return missingResource(eventIndex, event, resourceId, entry.resourceKind);
    if (entry.resourceKind === 'buffer' && resolved.resource.kind === 'buffer') {
      resources.push({
        kind: 'buffer',
        value: {
          buffer: resolved.resource.value,
          ...(entry.bufferOffset === undefined ? {} : { offset: entry.bufferOffset }),
          ...(entry.bufferSize === undefined ? {} : { size: entry.bufferSize }),
        },
      });
    } else if (entry.resourceKind === 'sampler' && resolved.resource.kind === 'sampler') {
      resources.push({ kind: 'sampler', value: resolved.resource.value });
    } else if (entry.resourceKind === 'textureView' && resolved.resource.kind === 'texture-view') {
      resources.push({ kind: 'textureView', value: resolved.resource.value });
    } else {
      return missingResource(eventIndex, event, resourceId, entry.resourceKind);
    }
  }
  const descriptor: BindGroupDescriptor = {
    layout: layout.value.value as never,
    entries: event.entries.map((entry, index) => ({
      binding: entry.binding,
      resource: resources[index] as RhiBindingResource,
    })),
  };
  return createResource(context, eventIndex, event, context.device.createBindGroup(descriptor), {
    kind: 'binding',
    role: 'bind-group',
  });
}

function createPipelineLayout(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createPipelineLayout' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layouts: import('@forgeax/engine-rhi').BindGroupLayout[] = [];
  for (const id of event.bglHandleIds) {
    const layout = requireReplayResource(context, id, 'binding', eventIndex, event.kind);
    if (!layout.ok || layout.value.role !== 'bind-group-layout')
      return pipelineError(layout, event, eventIndex);
    layouts.push(layout.value.value as import('@forgeax/engine-rhi').BindGroupLayout);
  }
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createPipelineLayout({ bindGroupLayouts: layouts }),
    { kind: 'binding', role: 'pipeline-layout' },
  );
}

function createRenderPipeline(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createRenderPipeline' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = requireReplayResource(
    context,
    event.layoutHandleId,
    'binding',
    eventIndex,
    event.kind,
  );
  if (!layout.ok || layout.value.role !== 'pipeline-layout')
    return pipelineError(layout, event, eventIndex);
  const vertex = event.desc.vertex;
  const fragment = event.desc.fragment;
  const vertexShader =
    vertex === undefined ? undefined : shaderValue(context, event.vertexShaderModuleHandleId);
  const fragmentShader =
    fragment === undefined ? undefined : shaderValue(context, event.fragmentShaderModuleHandleId);
  const descriptor = {
    ...event.desc,
    layout: layout.value.value as PipelineLayout,
    ...(vertex === undefined ? {} : { vertex: { ...vertex, module: vertexShader } }),
    ...(fragment === undefined
      ? {}
      : {
          fragment: {
            ...fragment,
            module: fragmentShader,
          },
        }),
  };
  if (
    (vertex !== undefined && vertexShader === undefined) ||
    (fragment !== undefined && fragmentShader === undefined)
  ) {
    return eventFailure(
      eventIndex,
      event,
      'lookup',
      'render pipeline shader module handle is missing',
    );
  }
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createRenderPipeline(descriptor as never),
    {
      kind: 'pipeline',
      role: 'render',
    },
  );
}

function createComputePipeline(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createComputePipeline' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = requireReplayResource(
    context,
    event.layoutHandleId,
    'binding',
    eventIndex,
    event.kind,
  );
  if (!layout.ok || layout.value.role !== 'pipeline-layout')
    return pipelineError(layout, event, eventIndex);
  const shader = shaderValue(context, event.computeShaderModuleHandleId);
  if (shader === undefined)
    return eventFailure(
      eventIndex,
      event,
      'lookup',
      'compute pipeline shader module handle is missing',
    );
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createComputePipeline({
      ...event.desc,
      layout: layout.value.value as PipelineLayout,
      compute: { ...event.desc.compute, module: shader },
    } as never),
    { kind: 'pipeline', role: 'compute' },
  );
}

function shaderValue(
  context: ReplayExecutionContext,
  id: string | undefined,
): import('@forgeax/engine-rhi').ShaderModule | undefined {
  if (id === undefined) return undefined;
  const entry = context.table.get(id);
  if (entry?.resource.kind !== 'shader-module') return undefined;
  return entry.resource.value;
}

function writeBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'writeBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const buffer = requireResource<Buffer>(context, event.handleId, 'buffer', eventIndex, event.kind);
  if (!buffer.ok) return buffer;
  const bytes = blob(context.tape, event.dataHash, event, eventIndex);
  if (!bytes.ok) return bytes;
  const result = context.queue.writeBuffer(
    buffer.value,
    event.bufferOffset,
    bytes.value,
    0,
    event.size,
  );
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'write', result.error);
}

function writeTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'writeTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const texture = requireResource<Texture>(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!texture.ok) return texture;
  const bytes = blob(context.tape, event.dataHash, event, eventIndex);
  if (!bytes.ok) return bytes;
  const result = context.queue.writeTexture(
    {
      texture: texture.value,
      mipLevel: event.destination.mipLevel ?? 0,
      origin: event.destination.origin,
      aspect: event.destination.aspect,
    } as never,
    bytes.value,
    {
      offset: event.dataLayout.offset ?? 0,
      ...(event.dataLayout.bytesPerRow === undefined
        ? {}
        : { bytesPerRow: event.dataLayout.bytesPerRow }),
      ...(event.dataLayout.rowsPerImage === undefined
        ? {}
        : { rowsPerImage: event.dataLayout.rowsPerImage }),
    },
    event.size,
  );
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'write', result.error);
}

function submit(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'submit' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const commandBuffers: CommandBuffer[] = [];
  for (const id of event.cmdHandleIds) {
    const entry = context.table.get(id);
    if (entry?.resource.kind !== 'encoder' || entry.resource.role !== 'command-buffer') {
      return missingResource(eventIndex, event, id, 'encoder');
    }
    commandBuffers.push(entry.resource.value as CommandBuffer);
  }
  const result = context.queue.submit(commandBuffers);
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'submit', result.error);
}

function beginRenderPass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'beginRenderPass' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  if (!encoder.ok) return encoder;
  const colors = Array.from(event.desc.colorAttachments).map((attachment, index) => {
    if (attachment === null || attachment === undefined) return attachment;
    const viewId = event.colorAttachmentViewHandleIds[index];
    const view = viewId === undefined ? undefined : context.table.get(viewId)?.resource;
    if (view?.kind !== 'texture-view') throw new Error(`missing color attachment view ${viewId}`);
    const resolveId = event.colorAttachmentResolveTargetHandleIds?.[index];
    const resolve = resolveId === undefined ? undefined : context.table.get(resolveId)?.resource;
    return {
      ...attachment,
      view: view.value,
      ...(resolve?.kind === 'texture-view' ? { resolveTarget: resolve.value } : {}),
    } as RenderPassColorAttachment;
  });
  const depth =
    event.depthStencilViewHandleId === undefined
      ? undefined
      : context.table.get(event.depthStencilViewHandleId)?.resource;
  const descriptor = {
    ...event.desc,
    colorAttachments: colors,
    ...(depth?.kind === 'texture-view'
      ? {
          depthStencilAttachment: {
            ...event.desc.depthStencilAttachment,
            view: depth.value,
          } as RenderPassDepthStencilAttachment,
        }
      : {}),
  };
  const pass = encoder.value.beginRenderPass(descriptor as never);
  return context.table.set(
    event.passHandleId,
    { kind: 'encoder', role: 'render-pass', value: pass },
    eventRecord(event),
  );
}

function beginComputePass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'beginComputePass' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  if (!encoder.ok) return encoder;
  const pass = encoder.value.beginComputePass(JSON.parse(JSON.stringify(event.desc)));
  return context.table.set(
    event.passHandleId,
    { kind: 'encoder', role: 'compute-pass', value: pass },
    eventRecord(event),
  );
}

function copyBufferToBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyBufferToBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  const source = requireResource<Buffer>(
    context,
    event.sourceHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  const destination = requireResource<Buffer>(
    context,
    event.destinationHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!source.ok) return source;
  if (!destination.ok) return destination;
  encoder.value.copyBufferToBuffer(
    source.value,
    event.sourceOffset,
    destination.value,
    event.destinationOffset,
    event.size,
  );
  return ok(undefined);
}

function copyBufferToTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyBufferToTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  const buffer = requireResource<Buffer>(
    context,
    event.source.bufferHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  const texture = requireResource<Texture>(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!buffer.ok) return buffer;
  if (!texture.ok) return texture;
  encoder.value.copyBufferToTexture(
    { ...event.source, buffer: buffer.value } as never,
    { ...event.destination, texture: texture.value } as never,
    event.copySize,
  );
  return ok(undefined);
}

function copyTextureToBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyTextureToBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  const texture = requireResource<Texture>(
    context,
    event.source.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  const buffer = requireResource<Buffer>(
    context,
    event.destination.bufferHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!texture.ok) return texture;
  if (!buffer.ok) return buffer;
  encoder.value.copyTextureToBuffer(
    { ...event.source, texture: texture.value } as never,
    { ...event.destination, buffer: buffer.value } as never,
    event.copySize,
  );
  return ok(undefined);
}

function copyTextureToTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyTextureToTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  const source = requireResource<Texture>(
    context,
    event.source.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  const destination = requireResource<Texture>(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!source.ok) return source;
  if (!destination.ok) return destination;
  encoder.value.copyTextureToTexture(
    { ...event.source, texture: source.value } as never,
    { ...event.destination, texture: destination.value } as never,
    event.copySize,
  );
  return ok(undefined);
}
