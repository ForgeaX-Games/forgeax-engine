import type {
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { buildFrameModel, type WorkBinding, type WorkPipeline } from '../frame-model';
import { buildTapeIndex, type TapeIndex, type TapeWorkEntry } from '../protocol/tape-index';
import type { BootstrapResource, RhiCallEvent, Tape } from '../protocol/types';
import type { CreateShaderModuleFn } from '../recorder';
import { computeTextureLayout, projectTextureExtent } from '../texel-layout';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';
import {
  type BufferReadbackRange,
  type ReplayReadbackResult,
  readReplayResource,
} from './readback';
import { ResourceTable } from './resources';

export interface ReplayBackend {
  readonly device: RhiDevice;
  readonly createShaderModule: CreateShaderModuleFn;
}

export interface TextureSubresource {
  readonly mipLevel: number;
  readonly arrayLayer: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export type ReadbackSubresource = TextureSubresource | BufferReadbackRange;

export type InspectField = 'bindings' | 'pipeline' | 'pixels';

export interface WorkInspection {
  readonly workIndex: number;
  readonly eventIndex: number;
  readonly passIndex: number;
  readonly attachment: ReplayReadbackResult | undefined;
  readonly pipeline?: WorkPipeline;
  readonly bindings?: readonly WorkBinding[];
  readonly vertexBuffers?: readonly {
    readonly slot: number;
    readonly bufferHandleId: string;
    readonly offset: number;
    readonly size: number | null;
  }[];
  readonly indexBuffer?: {
    readonly bufferHandleId: string;
    readonly format: string;
    readonly offset: number;
    readonly size: number | null;
  } | null;
  readonly shaders?: WorkPipeline['shaders'];
  readonly resourceIds?: readonly string[];
}

export interface ReplaySession {
  readonly generation: number;
  inspectWork(
    workIndex: number,
    fields?: readonly InspectField[],
    signal?: AbortSignal,
  ): Promise<Result<WorkInspection, RhiDebugError>>;
  readResource(
    resourceId: string,
    subresource?: ReadbackSubresource,
    signal?: AbortSignal,
  ): Promise<Result<ReplayReadbackResult, RhiDebugError>>;
  dispose(): Promise<Result<void, RhiDebugError>>;
}

export async function openReplay(
  tape: Tape,
  backend: ReplayBackend,
): Promise<Result<ReplaySession, RhiDebugError>> {
  if (tape.header.formatVersion !== 7) {
    return err(
      createRhiDebugError('tape-version-unsupported', {
        foundVersion: tape.header.formatVersion,
        expectedVersion: 7,
      }),
    );
  }
  const capabilityFailure = checkCapabilities(tape, backend.device);
  if (capabilityFailure !== undefined) return err(capabilityFailure);

  const index = buildTapeIndex(tape);
  const model = buildFrameModel(tape);
  const table = new ResourceTable(backend.device, 0);
  let disposed = false;
  let prepared = false;

  const context: ReplayExecutionContext = {
    device: backend.device,
    queue: backend.device.queue,
    tape,
    table,
    createShaderModule: backend.createShaderModule,
  };

  const reset = async (): Promise<Result<void, RhiDebugError>> => {
    const cleared = table.reset();
    if (!cleared.ok) return cleared;
    prepared = false;
    return ok(undefined);
  };

  const prepare = async (): Promise<Result<void, RhiDebugError>> => {
    if (prepared) return ok(undefined);
    for (let index = 0; index < tape.bootstrap.length; index++) {
      const resource = tape.bootstrap[index];
      if (resource === undefined) continue;
      const created = await executeBootstrapResource(context, resource, index);
      if (!created.ok) return created;
      const seeded = await seedBootstrapResource(context, resource, index);
      if (!seeded.ok) return seeded;
    }
    prepared = true;
    return ok(undefined);
  };

  const session: ReplaySession = {
    get generation() {
      return table.generation;
    },
    async inspectWork(workIndex, fields, signal) {
      if (disposed) return positionError(workIndex, index.works.length);
      if (signal?.aborted) return positionError(workIndex, index.works.length);
      const work = index.works[workIndex];
      const modelWork = model.works[workIndex];
      if (work === undefined) return positionError(workIndex, index.works.length);
      if (modelWork === undefined) return positionError(workIndex, index.works.length);
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      const replayed = await replayThroughWork(context, index, work, signal);
      if (!replayed.ok) return replayed;
      const attachment = fields?.includes('pixels')
        ? await readWorkAttachment(context, index, work)
        : undefined;
      if (attachment !== undefined && !attachment.ok) return attachment;
      const selectedAttachment =
        attachment?.ok === true
          ? {
              ...attachment.value,
              provenance: {
                ...attachment.value.provenance,
                selectedWorkIndex: work.workIndex,
              },
            }
          : undefined;
      const baseInspection = {
        workIndex: work.workIndex,
        eventIndex: work.eventIndex,
        passIndex: work.passIndex,
        attachment: selectedAttachment,
      };
      return ok({
        ...baseInspection,
        ...(fields?.includes('pipeline') ? { pipeline: modelWork.pipeline } : {}),
        ...(fields?.includes('bindings')
          ? {
              bindings: modelWork.bindings,
              vertexBuffers: modelWork.vertexBuffers,
              indexBuffer: modelWork.indexBuffer,
              shaders: modelWork.pipeline.shaders,
              resourceIds: modelWork.bindings
                .map((binding) => binding.resourceId)
                .filter((resourceId): resourceId is string => resourceId !== null),
            }
          : {}),
      });
    },
    async readResource(resourceId, subresource, signal) {
      if (disposed) {
        return err(
          createRhiDebugError('replay-position-invalid', {
            requested: -1,
            available: 0,
          }),
        );
      }
      if (signal?.aborted) {
        return err(
          createRhiDebugError('readback-failed', {
            stage: 'readback',
            cause: 'readback was aborted',
          }),
        );
      }
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      return readReplayResource(
        backend.device,
        table,
        resourceId,
        subresource,
        backend.createShaderModule,
      );
    },
    async dispose() {
      if (disposed) return ok(undefined);
      const result = table.dispose();
      disposed = true;
      prepared = false;
      return result;
    },
  };

  return ok(session);
}

function checkCapabilities(tape: Tape, device: RhiDevice): RhiDebugError | undefined {
  const recorded = tape.header.rhiCaps;
  const missing = Object.entries(recorded).filter(([key, value]) => {
    if (value !== true) return false;
    const target = device.caps[key as keyof typeof device.caps];
    return target !== true;
  });
  if (missing.length === 0) return undefined;
  return createRhiDebugError('replay-capability-mismatch', {
    stage: 'replay',
    cause: `missing capabilities: ${missing.map(([key]) => key).join(', ')}`,
  });
}

async function executeBootstrapResource(
  context: ReplayExecutionContext,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const event: RhiCallEvent = JSON.parse(JSON.stringify(resource.create));
  const result = await executeEvent(context, event, -bootstrapIndex - 1);
  return result;
}

async function seedBootstrapResource(
  context: ReplayExecutionContext,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  if (resource.initialData.length === 0) return ok(undefined);
  const entry = context.table.get(resource.handleId);
  const event: RhiCallEvent = JSON.parse(JSON.stringify(resource.create));
  if (entry?.resource.kind === 'texture' && event.kind === 'createTexture') {
    return seedTextureInitialData(context, entry.resource.value, event, resource, bootstrapIndex);
  }
  if (entry?.resource.kind !== 'buffer') {
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'lookup',
      'bootstrap initialData requires a buffer or color texture resource',
    );
  }
  for (const slice of resource.initialData) {
    const blob = context.tape.blobs.find((candidate) => candidate.hash === slice.hash);
    if (blob === undefined) {
      return eventFailure(-bootstrapIndex - 1, event, 'lookup', `blob ${slice.hash} is missing`);
    }
    const end = slice.byteOffset + slice.byteLength;
    if (slice.byteOffset < 0 || slice.byteLength < 0 || end > blob.bytes.byteLength) {
      return eventFailure(
        -bootstrapIndex - 1,
        event,
        'lookup',
        `blob ${slice.hash} does not contain initialData slice [${slice.byteOffset}, ${end})`,
      );
    }
    const bytes = blob.bytes.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    const written = context.queue.writeBuffer(entry.resource.value, 0, bytes);
    if (!written.ok) {
      return eventFailure(-bootstrapIndex - 1, event, 'write', written.error);
    }
  }
  return ok(undefined);
}

function seedTextureInitialData(
  context: ReplayExecutionContext,
  texture: import('@forgeax/engine-rhi').Texture,
  event: Extract<RhiCallEvent, { kind: 'createTexture' }>,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Result<void, RhiDebugError> {
  const extent = projectTextureExtent(event.desc.size);
  const layout = computeTextureLayout(
    event.desc.format,
    extent.width,
    extent.height,
    extent.layerCount,
    event.desc.mipLevelCount ?? 1,
  );
  if (layout === undefined) {
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'lookup',
      `texture format '${event.desc.format}' has no known bootstrap byte layout`,
    );
  }
  for (const slice of resource.initialData) {
    const blob = context.tape.blobs.find((candidate) => candidate.hash === slice.hash);
    if (blob === undefined) {
      return eventFailure(-bootstrapIndex - 1, event, 'lookup', `blob ${slice.hash} is missing`);
    }
    const end = slice.byteOffset + slice.byteLength;
    if (slice.byteOffset < 0 || slice.byteLength < 0 || end > blob.bytes.byteLength) {
      return eventFailure(
        -bootstrapIndex - 1,
        event,
        'lookup',
        `blob ${slice.hash} does not contain initialData slice [${slice.byteOffset}, ${end})`,
      );
    }
    const bytes = blob.bytes.subarray(slice.byteOffset, end);
    if (bytes.byteLength !== layout.totalBytes) {
      return eventFailure(
        -bootstrapIndex - 1,
        event,
        'lookup',
        `texture initialData has ${bytes.byteLength} bytes; expected ${layout.totalBytes}`,
      );
    }
    for (const subresource of layout.slices) {
      const rowBytes = Math.ceil(subresource.width / layout.blockWidth) * layout.bytesPerBlock;
      const rowCount = Math.ceil(subresource.height / layout.blockHeight);
      const subresourceBytes = bytes.subarray(
        subresource.byteOffset,
        subresource.byteOffset + subresource.byteLength,
      );
      const written = context.queue.writeTexture(
        {
          texture,
          mipLevel: subresource.mip,
          origin: { x: 0, y: 0, z: subresource.layer },
          aspect: 'all',
        } as never,
        subresourceBytes,
        { offset: 0, bytesPerRow: rowBytes, rowsPerImage: rowCount },
        {
          width: Math.ceil(subresource.width / layout.blockWidth) * layout.blockWidth,
          height: Math.ceil(subresource.height / layout.blockHeight) * layout.blockHeight,
          depthOrArrayLayers: 1,
        },
      );
      if (!written.ok) {
        return eventFailure(-bootstrapIndex - 1, event, 'write', written.error);
      }
    }
  }
  return ok(undefined);
}

async function replayThroughWork(
  context: ReplayExecutionContext,
  index: TapeIndex,
  work: TapeWorkEntry,
  signal?: AbortSignal,
): Promise<Result<void, RhiDebugError>> {
  for (let eventIndex = 0; eventIndex <= work.eventIndex; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined) break;
    if (signal?.aborted) {
      return eventFailure(eventIndex, event, 'lookup', 'inspectWork was aborted');
    }
    const result = await executeEvent(context, event, eventIndex);
    if (!result.ok) return result;
  }
  return finalizeWorkPass(context, index, work);
}

async function finalizeWorkPass(
  context: ReplayExecutionContext,
  index: TapeIndex,
  work: TapeWorkEntry,
): Promise<Result<void, RhiDebugError>> {
  const pass = index.passes.find((candidate) => candidate.passIndex === work.passIndex);
  if (pass === undefined) return ok(undefined);
  const begin = context.tape.events[pass.beginEventIndex];
  if (begin?.kind !== 'beginRenderPass' && begin?.kind !== 'beginComputePass') return ok(undefined);
  const entry = context.table.get(begin.passHandleId);
  if (
    entry?.resource.kind !== 'encoder' ||
    (entry.resource.role !== 'render-pass' && entry.resource.role !== 'compute-pass')
  ) {
    return eventFailure(
      pass.beginEventIndex,
      begin,
      'lookup',
      `pass ${begin.passHandleId} is not open`,
    );
  }
  try {
    (entry.resource.value as RhiRenderPassEncoder | RhiComputePassEncoder).end();
  } catch (cause) {
    return eventFailure(pass.endEventIndex ?? work.eventIndex, begin, 'encode', cause);
  }
  context.table.delete(begin.passHandleId);
  const finishEventIndex = findNextEvent(
    context.tape.events,
    pass.beginEventIndex,
    'finish',
    begin.cmdHandleId,
  );
  const encoder = context.table.get(begin.cmdHandleId);
  if (encoder?.resource.kind !== 'encoder' || encoder.resource.role !== 'command') {
    return eventFailure(
      finishEventIndex ?? work.eventIndex,
      begin,
      'lookup',
      `encoder ${begin.cmdHandleId} is not available`,
    );
  }
  const finished = (encoder.resource.value as RhiCommandEncoder).finish();
  const finishEvent = context.tape.events[finishEventIndex ?? work.eventIndex] ?? begin;
  if (!finished.ok)
    return eventFailure(finishEventIndex ?? work.eventIndex, finishEvent, 'finish', finished.error);
  context.table.set(begin.cmdHandleId, {
    kind: 'encoder',
    role: 'command-buffer',
    value: finished.value,
  });
  const submitEventIndex = findNextEvent(
    context.tape.events,
    finishEventIndex ?? pass.beginEventIndex,
    'submit',
    begin.cmdHandleId,
  );
  const submitted = context.queue.submit([finished.value]);
  const submitEvent = context.tape.events[submitEventIndex ?? work.eventIndex] ?? begin;
  if (!submitted.ok)
    return eventFailure(
      submitEventIndex ?? work.eventIndex,
      submitEvent,
      'submit',
      submitted.error,
    );
  await context.queue.onSubmittedWorkDone();
  return ok(undefined);
}

function findNextEvent(
  events: readonly RhiCallEvent[],
  start: number,
  kind: 'finish' | 'submit',
  commandId: string,
): number | undefined {
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index];
    if (event?.kind === 'finish' && kind === 'finish' && event.cmdHandleId === commandId)
      return index;
    if (event?.kind === 'submit' && kind === 'submit' && event.cmdHandleIds.includes(commandId))
      return index;
  }
  return undefined;
}

function positionError(requested: number, available: number): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-position-invalid', {
      requested,
      available,
    }),
  );
}

async function readWorkAttachment(
  context: ReplayExecutionContext,
  index: TapeIndex,
  work: TapeWorkEntry,
): Promise<Result<ReplayReadbackResult, RhiDebugError>> {
  const pass = index.passes.find((candidate) => candidate.passIndex === work.passIndex);
  const begin = pass === undefined ? undefined : context.tape.events[pass.beginEventIndex];
  if (begin?.kind !== 'beginRenderPass') {
    return err(
      createRhiDebugError('readback-unsupported', {
        stage: 'readback',
        reason: 'work has no color attachment',
      }),
    );
  }
  const viewId = begin.colorAttachmentViewHandleIds.find(
    (candidate): candidate is string => candidate !== undefined,
  );
  if (viewId === undefined) {
    return err(
      createRhiDebugError('readback-unsupported', {
        stage: 'readback',
        reason: 'render pass has no readable color attachment view',
      }),
    );
  }
  return readReplayResource(
    context.device,
    context.table,
    viewId,
    undefined,
    context.createShaderModule,
  );
}

export type { BufferReadbackRange, ReplayReadbackResult } from './readback';
