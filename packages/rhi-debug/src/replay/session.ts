import type {
  MappedBuffer,
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
import { requiredReplayDescriptorFeatures } from './device-request';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';
import {
  type BufferReadbackRange,
  type ReplayReadbackResult,
  readReplayResource,
} from './readback';
import { ResourceTable } from './resources';
import { seedDepthInitialData } from './seed-depth';

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
  /**
   * Replay the captured stream through one indexed work item, then read the
   * resource from that exact post-work state.  Unlike readResource(), this is
   * not a bootstrap-only read and therefore can inspect compute/storage
   * outputs produced by the selected work without creating a second tape.
   */
  readResourceAtWork(
    resourceId: string,
    workIndex: number,
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
    async readResourceAtWork(resourceId, workIndex, subresource, signal) {
      if (disposed) return positionError(workIndex, index.works.length);
      if (signal?.aborted) {
        return err(
          createRhiDebugError('readback-failed', {
            stage: 'readback',
            cause: 'readback was aborted',
          }),
        );
      }
      const work = index.works[workIndex];
      if (work === undefined || model.works[workIndex] === undefined) {
        return positionError(workIndex, index.works.length);
      }
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      const replayed = await replayThroughWork(context, index, work, signal);
      if (!replayed.ok) return replayed;
      const read = await readReplayResource(
        backend.device,
        table,
        resourceId,
        subresource,
        backend.createShaderModule,
      );
      if (!read.ok) return read;
      return ok({
        ...read.value,
        provenance: {
          ...read.value.provenance,
          selectedWorkIndex: work.workIndex,
        },
      });
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
  const missingFeatures = [...requiredReplayDescriptorFeatures(tape)].filter(
    (feature) => !device.features.has(feature),
  );
  if (missingFeatures.length > 0) {
    return createRhiDebugError('replay-capability-mismatch', {
      stage: 'replay',
      cause: `missing device features: ${missingFeatures.join(', ')}`,
    });
  }
  const recorded = tape.header.rhiCaps;
  const required = requiredReplayCapabilities(tape);
  const missing = Object.entries(recorded).filter(([key, value]) => {
    // A recorder snapshots the device's available capabilities, but replay
    // only needs to require a capability when the captured workload can use
    // it. Otherwise a device-wide optional feature (for example ASTC support)
    // makes an unrelated RGBA tape non-portable.
    if (value !== true || (!required.has(key) && isKnownReplayCapability(key))) return false;
    const target = device.caps[key as keyof typeof device.caps];
    return target !== true;
  });
  if (missing.length === 0) return undefined;
  return createRhiDebugError('replay-capability-mismatch', {
    stage: 'replay',
    cause: `missing capabilities: ${missing.map(([key]) => key).join(', ')}`,
  });
}

const BC_TEXTURE_FORMATS = new Set([
  'bc1-rgba-unorm',
  'bc1-rgba-unorm-srgb',
  'bc2-rgba-unorm',
  'bc2-rgba-unorm-srgb',
  'bc3-rgba-unorm',
  'bc3-rgba-unorm-srgb',
  'bc4-r-unorm',
  'bc4-r-snorm',
  'bc5-rg-unorm',
  'bc5-rg-snorm',
  'bc6h-rgb-ufloat',
  'bc6h-rgb-sfloat',
  'bc7-rgba-unorm',
  'bc7-rgba-unorm-srgb',
]);

const ETC2_TEXTURE_FORMATS = new Set([
  'etc2-rgb8unorm',
  'etc2-rgb8unorm-srgb',
  'etc2-rgb8a1unorm',
  'etc2-rgb8a1unorm-srgb',
  'etc2-rgba8unorm',
  'etc2-rgba8unorm-srgb',
  'eac-r11unorm',
  'eac-r11snorm',
  'eac-rg11unorm',
  'eac-rg11snorm',
]);

const KNOWN_REPLAY_CAPABILITIES = new Set([
  'rgba16floatRenderable',
  'float32Filterable',
  'textureCompressionBc',
  'textureCompressionEtc2',
  'textureCompressionAstc',
  'storageBuffer',
  'timestampQuery',
]);

function isKnownReplayCapability(key: string): boolean {
  return KNOWN_REPLAY_CAPABILITIES.has(key);
}

function requiredReplayCapabilities(tape: Tape): ReadonlySet<string> {
  const required = new Set<string>();
  const events = [
    ...tape.bootstrap.map((resource) => resource.create as unknown as RhiCallEvent),
    ...tape.events,
  ];
  for (const event of events) {
    switch (event.kind) {
      case 'createTexture': {
        const formats = [event.desc.format, ...(event.desc.viewFormats ?? [])];
        for (const format of formats) {
          if (BC_TEXTURE_FORMATS.has(format)) required.add('textureCompressionBc');
          if (ETC2_TEXTURE_FORMATS.has(format)) required.add('textureCompressionEtc2');
          if (format.startsWith('astc-')) required.add('textureCompressionAstc');
          if (format === 'rgba16float') required.add('rgba16floatRenderable');
          if (format === 'r32float' || format === 'rg32float' || format === 'rgba32float') {
            required.add('float32Filterable');
          }
        }
        break;
      }
      case 'createBindGroupLayout':
        if (
          Array.from(event.desc.entries).some(
            (entry) =>
              entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage',
          )
        ) {
          required.add('storageBuffer');
        }
        break;
      case 'createBuffer':
        // GPUBufferUsage.STORAGE is 0x80 in the WebGPU enum. Keep the replay
        // package independent of the browser-only global constant.
        if ((event.desc.usage & 0x80) !== 0) required.add('storageBuffer');
        break;
      default:
        break;
    }
  }
  return required;
}

async function executeBootstrapResource(
  context: ReplayExecutionContext,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const event: RhiCallEvent = JSON.parse(JSON.stringify(resource.create));
  // Captured GPU-written buffers need not allow COPY_DST. Restore their
  // initial bytes through creation mapping, which is legal for every usage
  // (including MAP_WRITE, where adding COPY_DST would itself be invalid).
  const replayEvent =
    event.kind === 'createBuffer' && resource.initialData.length > 0
      ? { ...event, desc: { ...event.desc, mappedAtCreation: true } }
      : event;
  const result = await executeEvent(context, replayEvent, -bootstrapIndex - 1);
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
      'bootstrap initialData requires a buffer or supported texture resource',
    );
  }
  // executeBootstrapResource created this buffer mapped specifically for
  // restoration. It must be unmapped before any recorded work can consume it.
  const mapped = entry.resource.value as MappedBuffer;
  // RhiNull deliberately exposes opaque structural handles rather than a
  // CPU-visible mapping implementation. Its replay bytes have no observable
  // storage, so there is nothing to seed; real backends always provide the
  // MappedBuffer methods below and still take the strict mapping path.
  if (
    typeof (mapped as Partial<MappedBuffer>).getMappedRange !== 'function' ||
    typeof (mapped as Partial<MappedBuffer>).unmap !== 'function'
  ) {
    if (context.device.caps.backendKind === 'null') return ok(undefined);
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'write',
      'bootstrap buffer mapping is unavailable on the replay backend',
    );
  }
  try {
    const range = mapped.getMappedRange();
    if (!range.ok) return eventFailure(-bootstrapIndex - 1, event, 'write', range.error);
    const target = new Uint8Array(range.value);
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
      if (slice.byteLength > target.byteLength) {
        return eventFailure(-bootstrapIndex - 1, event, 'write', 'initialData exceeds buffer size');
      }
      target.set(blob.bytes.subarray(slice.byteOffset, end));
    }
  } finally {
    mapped.unmap();
  }
  return ok(undefined);
}

async function seedTextureInitialData(
  context: ReplayExecutionContext,
  texture: import('@forgeax/engine-rhi').Texture,
  event: Extract<RhiCallEvent, { kind: 'createTexture' }>,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
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
    if (event.desc.format === 'depth32float') {
      const restored = await seedDepthInitialData(
        context,
        texture,
        event,
        bytes,
        layout,
        bootstrapIndex,
      );
      if (!restored.ok) return restored;
      continue;
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
  const closed = closeReplayPass(context, entry, begin, pass, work.eventIndex);
  if (!closed.ok) return closed;
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
  const closure = await replayCommandClosure(
    context,
    begin.cmdHandleId,
    (pass.endEventIndex ?? work.eventIndex) + 1,
    finishEventIndex ?? context.tape.events.length,
  );
  if (!closure.ok) return closure;
  const groupsClosed = closeReplayDebugGroups(
    context,
    begin.cmdHandleId,
    work.eventIndex,
    encoder.resource.value as RhiCommandEncoder,
  );
  if (!groupsClosed.ok) return groupsClosed;
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
  // Queue uploads are ordered against submission, not command recording.
  // Include later uploads to retained resources before this submission while
  // leaving later GPU work and resources outside the selected prefix alone.
  for (
    let eventIndex = work.eventIndex + 1;
    eventIndex < (submitEventIndex ?? work.eventIndex + 1);
    eventIndex++
  ) {
    const event = context.tape.events[eventIndex];
    if (event?.kind !== 'writeBuffer' && event?.kind !== 'writeTexture') continue;
    const resourceId =
      event.kind === 'writeBuffer' ? event.handleId : event.destination.textureHandleId;
    if (context.table.get(resourceId) === undefined) continue;
    const uploaded = await executeEvent(context, event, eventIndex);
    if (!uploaded.ok) return uploaded;
  }
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

function closeReplayPass(
  context: ReplayExecutionContext,
  entry: NonNullable<ReturnType<ReplayExecutionContext['table']['get']>>,
  begin: Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>,
  pass: TapeIndex['passes'][number],
  selectedEventIndex: number,
): Result<void, RhiDebugError> {
  const activeQuery = activeOcclusionQuery(
    context.tape.events,
    begin.kind === 'beginRenderPass' ? begin.passHandleId : undefined,
    pass.beginEventIndex,
    selectedEventIndex,
  );
  if (!activeQuery.ok) return activeQuery;
  try {
    if (activeQuery.value !== undefined) {
      if (entry.resource.role !== 'render-pass') {
        return eventFailure(
          activeQuery.value.eventIndex,
          activeQuery.value.event,
          'lookup',
          'an active occlusion query belongs to a non-render pass',
        );
      }
      const endedQuery = (entry.resource.value as RhiRenderPassEncoder).endOcclusionQuery();
      if (!endedQuery.ok) {
        return eventFailure(
          activeQuery.value.eventIndex,
          activeQuery.value.event,
          'encode',
          endedQuery.error,
        );
      }
    }
    if (entry.resource.role === 'render-pass') {
      const groupsClosed = closeReplayDebugGroups(
        context,
        begin.passHandleId,
        selectedEventIndex,
        entry.resource.value as RhiRenderPassEncoder,
      );
      if (!groupsClosed.ok) return groupsClosed;
    }
    (entry.resource.value as RhiRenderPassEncoder | RhiComputePassEncoder).end();
  } catch (cause) {
    return eventFailure(pass.endEventIndex ?? selectedEventIndex, begin, 'encode', cause);
  }
  context.table.delete(begin.passHandleId);
  return ok(undefined);
}

// Inspection stops at the selected work, before the recorded scope exits.
// Derive only the still-open scopes from that prefix; never execute later work.
function closeReplayDebugGroups(
  context: ReplayExecutionContext,
  handleId: string,
  throughEventIndex: number,
  encoder: RhiCommandEncoder | RhiRenderPassEncoder,
): Result<void, RhiDebugError> {
  const open: { event: RhiCallEvent; eventIndex: number }[] = [];
  for (let eventIndex = 0; eventIndex <= throughEventIndex; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined) continue;
    if (
      (event.kind === 'pushDebugGroup' && event.cmdHandleId === handleId) ||
      (event.kind === 'passPushDebugGroup' && event.passHandleId === handleId)
    ) {
      open.push({ event, eventIndex });
    } else if (
      (event.kind === 'popDebugGroup' && event.cmdHandleId === handleId) ||
      (event.kind === 'passPopDebugGroup' && event.passHandleId === handleId)
    ) {
      open.pop();
    }
  }
  for (let index = open.length - 1; index >= 0; index--) {
    const scope = open[index];
    if (scope === undefined) continue;
    try {
      encoder.popDebugGroup();
    } catch (cause) {
      return eventFailure(scope.eventIndex, scope.event, 'encode', cause);
    }
  }
  return ok(undefined);
}

async function replayCommandClosure(
  context: ReplayExecutionContext,
  cmdHandleId: string,
  start: number,
  end: number,
): Promise<Result<void, RhiDebugError>> {
  for (let eventIndex = start; eventIndex < end; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined || !isCommandClosureEvent(event)) continue;
    if (event.cmdHandleId !== cmdHandleId) continue;
    const result = await executeEvent(context, event, eventIndex);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

type ActiveOcclusionQuery = Extract<RhiCallEvent, { kind: 'beginOcclusionQuery' }>;

function activeOcclusionQuery(
  events: readonly RhiCallEvent[],
  passHandleId: string | undefined,
  beginEventIndex: number,
  selectedEventIndex: number,
): Result<
  { readonly eventIndex: number; readonly event: ActiveOcclusionQuery } | undefined,
  RhiDebugError
> {
  if (passHandleId === undefined) return ok(undefined);
  let active: { readonly eventIndex: number; readonly event: ActiveOcclusionQuery } | undefined;
  for (let eventIndex = beginEventIndex + 1; eventIndex <= selectedEventIndex; eventIndex++) {
    const event = events[eventIndex];
    if (event === undefined || !('passHandleId' in event) || event.passHandleId !== passHandleId)
      continue;
    if (event.kind === 'beginOcclusionQuery') {
      if (active !== undefined) {
        return eventFailure(
          eventIndex,
          event,
          'encode',
          'an occlusion query is already active for this render pass',
        );
      }
      active = { eventIndex, event };
    } else if (event.kind === 'endOcclusionQuery') {
      if (active === undefined) {
        return eventFailure(
          eventIndex,
          event,
          'encode',
          'an occlusion query ended without a matching begin',
        );
      }
      active = undefined;
    }
  }
  return ok(active);
}

function isCommandClosureEvent(event: RhiCallEvent): event is Extract<
  RhiCallEvent,
  {
    kind:
      | 'resolveQuerySet'
      | 'copyBufferToBuffer'
      | 'copyBufferToTexture'
      | 'copyTextureToBuffer'
      | 'copyTextureToTexture'
      | 'clearBuffer';
  }
> {
  switch (event.kind) {
    case 'resolveQuerySet':
    case 'copyBufferToBuffer':
    case 'copyBufferToTexture':
    case 'copyTextureToBuffer':
    case 'copyTextureToTexture':
    case 'clearBuffer':
      return true;
    default:
      return false;
  }
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
  const attachmentIndex = begin.colorAttachmentViewHandleIds.findIndex(
    (candidate) => candidate !== undefined,
  );
  // finalizeWorkPass has ended the pass and resolved the selected work.
  // Keep the resolve target paired with its color slot, including sparse MRTs.
  const viewId =
    begin.colorAttachmentResolveTargetHandleIds?.[attachmentIndex] ??
    begin.colorAttachmentViewHandleIds[attachmentIndex];
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
