// @forgeax/engine-rhi-debug/src/replayer — deterministic tape replay on a fresh RhiDevice.
//
// Core architecture:
// - createReplay(tape, device): builds a Replay object that can step through
//   tape events, recreating RHI resources on the target device.
// - Caps fail-fast: tape.rhiCapsRecorded must be a subset of target device caps.
//   Any missing cap returns DebugError code='caps-mismatch' with structured
//   detail.missingCaps array.
// - handleMap: Map<HandleId, recreated handle object> — single-level mapping
//   because forgeax Handle<T> brand types do not collide across kinds (research F-1).
// - stepTo(N): replays events[currentIdx..N] sequentially on the target device.
// - reset(): destroys all recreated handles, clears handleMap, resets currentIdx to 0.
// - onSubmittedWorkDone: after each submit event, await device.queue.onSubmittedWorkDone()
//   to ensure GPU execution completes before the next event.
//
// Related: requirements AC-11/AC-12/AC-13; plan-strategy D-1/D-3/D-7; m5-1 / m5-2.

// biome-ignore-all lint/suspicious/noExplicitAny: replayer bridges JSON-serializable RHI event types
// to RHI branded opaque handle types. Structural (as any) casts at the serialization boundary are
// inherent to this layer; RhiCallEvent types use Iterable/readonly for serialization while RHI
// descriptor types expect Array / specific GPU object shapes.

/// <reference types="@webgpu/types" />

import type {
  BindGroupLayout,
  BufferDescriptor,
  CommandEncoderDescriptor,
  PipelineLayout,
  Result,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiQueue,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { readbackTexturePixels, resolveAttachmentSize } from './readback';
import type { CreateShaderModuleFn } from './recorder';
import type {
  HandleId,
  RhiCallEvent,
  RhiCallEventBeginComputePass,
  RhiCallEventBeginRenderPass,
  RhiCallEventClearBuffer,
  RhiCallEventCopyBufferToBuffer,
  RhiCallEventCopyBufferToTexture,
  RhiCallEventCopyTextureToBuffer,
  RhiCallEventCopyTextureToTexture,
  RhiCallEventCreateBindGroup,
  RhiCallEventCreateBindGroupLayout,
  RhiCallEventCreateBuffer,
  RhiCallEventCreateCommandEncoder,
  RhiCallEventCreateComputePipeline,
  RhiCallEventCreatePipelineLayout,
  RhiCallEventCreateRenderPipeline,
  RhiCallEventCreateSampler,
  RhiCallEventCreateShaderModule,
  RhiCallEventCreateTexture,
  RhiCallEventCreateTextureView,
  RhiCallEventDispatchWorkgroups,
  RhiCallEventDraw,
  RhiCallEventDrawIndexed,
  RhiCallEventEndComputePass,
  RhiCallEventEndRenderPass,
  RhiCallEventFinish,
  RhiCallEventInsertDebugMarker,
  RhiCallEventPopDebugGroup,
  RhiCallEventPushDebugGroup,
  RhiCallEventSetBindGroup,
  RhiCallEventSetComputePipeline,
  RhiCallEventSetIndexBuffer,
  RhiCallEventSetPipeline,
  RhiCallEventSetScissorRect,
  RhiCallEventSetVertexBuffer,
  RhiCallEventSetViewport,
  RhiCallEventSubmit,
  RhiCallEventWriteBuffer,
  RhiCallEventWriteTexture,
  RhiCapsRecorded,
  Tape,
} from './types';

type PassEncoder = RhiRenderPassEncoder | RhiComputePassEncoder;

// ============================================================================
// Caps mapping: RhiCapsRecorded keys -> human-readable labels
// ============================================================================

const CAPS_KEY_LABELS: Record<keyof RhiCapsRecorded, string> = {
  canvasFormat: 'canvas-format',
  rgba16floatRenderable: 'rgba16float-renderable',
  float32Filterable: 'float32-filterable',
  textureCompression: 'texture-compression',
  storageBuffer: 'storage-buffer',
  timestampQuery: 'timestamp-query',
};

// ============================================================================
// Replay interface
// ============================================================================

/**
 * A replay session that can step through tape events on a fresh RhiDevice.
 *
 * Created by createReplay(); see that function for construction semantics.
 */
export interface Replay {
  /** Step replay forward from current position to event index N (inclusive). */
  readonly stepTo: (n: number) => Promise<Result<void, DebugError>>;

  /**
   * Reset the replay to its initial state.
   *
   * Destroys all recreated GPU resources, clears the handle map,
   * and sets currentEventIdx back to 0. After reset, stepTo(N) is
   * legal again from event 0.
   */
  readonly reset: () => void;

  /**
   * Dispose the replay session, destroying all recreated GPU resources.
   *
   * After dispose, stepTo is no longer callable.
   */
  readonly dispose: () => void;

  /**
   * @internal
   * Resolve a handleId to the recreated GPU resource.
   *
   * Used by the inspector module to access textures/buffers for
   * RT readback. Not part of the public API contract.
   */
  readonly _resolveHandle: (handleId: string) => unknown;

  /**
   * Read back render target pixel data from the replay's color attachment.
   *
   * Traverses the tape events to find the last beginRenderPass color
   * attachment, resolves its real texture dimensions, then copies the
   * texture to a staging buffer and maps it back to host-side memory.
   *
   * The returned Uint8Array has length = width * height * 4 (RGBA8).
   * This is a read-only operation — it does not modify currentEventIdx
   * or the replay state.
   *
   * @param rtIdx - Index of the color attachment (default 0).
   * @returns Ok({width, height, pixels}) or Err(DebugError) on failure.
   */
  readonly readbackRt: (rtIdx?: number) => Promise<
    Result<
      {
        readonly width: number;
        readonly height: number;
        readonly pixels: Uint8Array;
      },
      DebugError
    >
  >;

  /**
   * @internal
   * The tape events array used to construct this replay.
   *
   * Used by the inspector module to extract draw info.
   */
  readonly _events: readonly import('./types').RhiCallEvent[];
}

// ============================================================================
// createReplay — main entry point (m5-1)
// ============================================================================

/**
 * Create a Replay object from a Tape and a target RhiDevice.
 *
 * **Caps fail-fast** (m5-1): checks that the target device's caps cover
 * every capability recorded in the tape. Each boolean field in
 * tape.rhiCapsRecorded must be <= the corresponding field in device.caps.
 * Missing caps produce a DebugError with code='caps-mismatch' and
 * detail.missingCaps listing the RhiCapsRecorded key names.
 *
 * **Canvas format** is also recorded in RhiCapsRecorded for informational
 * purposes; the canvas-format cap key is included in the labels map.
 *
 * **createShaderModuleFn** (optional, round 2 m5b-3): if provided, shader
 * module creation events will be replayed using this function. Without it,
 * createShaderModule events are silently skipped (v1 default). This is
 * required for dawn-node e2e tests that need real WGSL shader compilation
 * on the replay device.
 *
 * @param tape - The deserialized tape to replay.
 * @param device - The target RhiDevice to replay onto.
 * @param createShaderModuleFn - Optional shader creation function for replay.
 * @returns Ok(Replay) or Err(DebugError) on caps mismatch.
 */
export function createReplay(
  tape: Tape,
  device: RhiDevice,
  createShaderModuleFn?: CreateShaderModuleFn,
): Result<Replay, DebugError> {
  // m5-1: caps fail-fast check.
  // detail.missingCaps carries raw RhiCapsRecordedKey values (typed for
  // AI-user `switch` narrowing, AC-11). hint carries the human-readable
  // labels via CAPS_KEY_LABELS — prose stays out of the structured slot.
  const missingCaps = computeMissingCaps(tape.rhiCapsRecorded, device.caps);
  if (missingCaps.length > 0) {
    return err(
      new DebugError({
        code: 'caps-mismatch',
        expected: 'target device caps must satisfy all tape.rhiCapsRecorded entries',
        hint: `missing caps: ${missingCaps.map((k) => CAPS_KEY_LABELS[k]).join(', ')}; target device lacks these capabilities that the recording device had`,
        detail: {
          missingCaps,
        },
      }),
    );
  }

  const handleMap = new Map<HandleId, unknown>();
  const encoderMap = new Map<HandleId, RhiCommandEncoder>();
  const passEncoderMap = new Map<HandleId, PassEncoder>();
  let _currentEventIdx = 0;
  let _disposed = false;

  const deviceQueue: RhiQueue = device.queue;

  const replay: Replay = {
    stepTo(n: number): Promise<Result<void, DebugError>> {
      return stepToImpl(
        tape,
        device,
        deviceQueue,
        handleMap,
        encoderMap,
        passEncoderMap,
        n,
        () => _currentEventIdx,
        (v: number) => {
          _currentEventIdx = v;
        },
        () => _disposed,
        createShaderModuleFn,
      );
    },

    reset(): void {
      resetImpl(handleMap, device);
      _currentEventIdx = 0;
      _disposed = false;
    },

    dispose(): void {
      disposeImpl(handleMap, device);
      _disposed = true;
    },

    _resolveHandle(handleId: string): unknown {
      return handleMap.get(handleId);
    },

    async readbackRt(rtIdx: number = 0): Promise<
      Result<
        {
          readonly width: number;
          readonly height: number;
          readonly pixels: Uint8Array;
        },
        DebugError
      >
    > {
      return readbackRtImpl(tape, device, handleMap, rtIdx);
    },

    _events: tape.events,
  };

  return ok(replay);
}

// ============================================================================
// Caps check (m5-1)
// ============================================================================

interface RhiCapsShape {
  readonly rgba16floatRenderable: boolean;
  readonly float32Filterable: boolean;
  readonly textureCompression: boolean;
  readonly storageBuffer: boolean;
  readonly timestampQuery: boolean;
}

/**
 * Compute which RhiCapsRecorded keys are not satisfied by the target device caps.
 *
 * The check is: for each boolean field in recorded, if it is `true` and the
 * corresponding target field is `false`, it's a "missing" cap.
 */
function computeMissingCaps(
  recorded: RhiCapsRecorded,
  targetCaps: RhiCapsShape,
): (keyof RhiCapsRecorded)[] {
  const missing: (keyof RhiCapsRecorded)[] = [];

  if (recorded.rgba16floatRenderable && !targetCaps.rgba16floatRenderable) {
    missing.push('rgba16floatRenderable');
  }
  if (recorded.float32Filterable && !targetCaps.float32Filterable) {
    missing.push('float32Filterable');
  }
  if (recorded.textureCompression && !targetCaps.textureCompression) {
    missing.push('textureCompression');
  }
  if (recorded.storageBuffer && !targetCaps.storageBuffer) {
    missing.push('storageBuffer');
  }
  if (recorded.timestampQuery && !targetCaps.timestampQuery) {
    missing.push('timestampQuery');
  }

  return missing;
}

// ============================================================================
// stepToImpl (m5-2)
// ============================================================================

/**
 * Replay events from currentIdx (inclusive) to n (inclusive).
 */
async function stepToImpl(
  tape: Tape,
  device: RhiDevice,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
  n: number,
  getCurrentIdx: () => number,
  setCurrentIdx: (v: number) => void,
  getDisposed: () => boolean,
  createShaderModuleFn?: CreateShaderModuleFn,
): Promise<Result<void, DebugError>> {
  if (getDisposed()) {
    return err(
      new DebugError({
        code: 'replay-step-out-of-range',
        expected: 'Replay is already disposed',
        hint: 'create a new Replay session after dispose',
        detail: {
          requestedStep: n,
          currentStep: getCurrentIdx(),
          totalEvents: tape.events.length,
        },
      }),
    );
  }

  const totalEvents = tape.events.length;

  if (n < getCurrentIdx()) {
    return err(
      new DebugError({
        code: 'replay-step-out-of-range',
        expected: `stepTo(N) with N >= currentEventIdx (${getCurrentIdx()})`,
        hint: `cannot step backward from ${getCurrentIdx()} to ${n}; call reset() first to start over from event 0`,
        detail: {
          requestedStep: n,
          currentStep: getCurrentIdx(),
          totalEvents,
        },
      }),
    );
  }

  if (n >= totalEvents) {
    return err(
      new DebugError({
        code: 'replay-step-out-of-range',
        expected: `stepTo(N) with N < totalEvents (${totalEvents})`,
        hint: `requested step ${n} is out of range; tape has ${totalEvents} events (indices 0..${totalEvents - 1})`,
        detail: {
          requestedStep: n,
          currentStep: getCurrentIdx(),
          totalEvents,
        },
      }),
    );
  }

  const events = tape.events;

  for (let i = getCurrentIdx(); i <= n; i++) {
    const event = events[i];
    if (event === undefined) break;

    await replayEvent(
      event,
      tape,
      device,
      queue,
      handleMap,
      encoderMap,
      passEncoderMap,
      createShaderModuleFn,
    );
    setCurrentIdx(i + 1);
  }

  return ok(undefined);
}

// ============================================================================
// resetImpl (m5-2)
// ============================================================================

function resetImpl(handleMap: Map<HandleId, unknown>, device: RhiDevice): void {
  for (const handle of handleMap.values()) {
    try {
      device.destroyBuffer(handle as any);
    } catch {
      // Not a buffer
    }
    try {
      device.destroyTexture(handle as any);
    } catch {
      // Not a texture
    }
  }

  handleMap.clear();
}

// ============================================================================
// disposeImpl
// ============================================================================

function disposeImpl(handleMap: Map<HandleId, unknown>, device: RhiDevice): void {
  resetImpl(handleMap, device);
}

// ============================================================================
// Event replay dispatcher (m5-2)
// ============================================================================

/**
 * Replay a single RhiCallEvent on the target device.
 */
async function replayEvent(
  event: RhiCallEvent,
  tape: Tape,
  device: RhiDevice,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
  createShaderModuleFn?: CreateShaderModuleFn,
): Promise<void> {
  switch (event.kind) {
    case 'frameMark':
      break;

    case 'createBuffer':
      replayCreateBuffer(event, device, handleMap);
      break;

    case 'createTexture':
      replayCreateTexture(event, device, handleMap);
      break;

    case 'createTextureView':
      replayCreateTextureView(event, device, handleMap);
      break;

    case 'createSampler':
      replayCreateSampler(event, device, handleMap);
      break;

    case 'createBindGroupLayout':
      replayCreateBindGroupLayout(event, device, handleMap);
      break;

    case 'createBindGroup':
      replayCreateBindGroup(event, device, handleMap);
      break;

    case 'createPipelineLayout':
      replayCreatePipelineLayout(event, device, handleMap);
      break;

    case 'createRenderPipeline':
      replayCreateRenderPipeline(event, device, handleMap);
      break;

    case 'createComputePipeline':
      replayCreateComputePipeline(event, device, handleMap);
      break;

    case 'createShaderModule':
      await replayCreateShaderModule(event, device, handleMap, createShaderModuleFn);
      break;

    case 'createCommandEncoder':
      replayCreateCommandEncoder(event, device, handleMap, encoderMap);
      break;

    case 'writeBuffer':
      replayWriteBuffer(event, queue, handleMap, tape);
      break;

    case 'writeTexture':
      replayWriteTexture(event, queue, handleMap, tape);
      break;

    case 'copyExternalImageToTexture':
      // v1 skip: requires live canvas/browser context
      break;

    case 'submit':
      replaySubmit(event, queue, handleMap);
      // m5-2: await onSubmittedWorkDone after each submit
      await queue.onSubmittedWorkDone();
      break;

    case 'beginRenderPass':
      replayBeginRenderPass(event, handleMap, encoderMap, passEncoderMap);
      break;

    case 'beginComputePass':
      replayBeginComputePass(event, handleMap, encoderMap, passEncoderMap);
      break;

    case 'copyBufferToBuffer':
      replayCopyBufferToBuffer(event, handleMap, encoderMap);
      break;

    case 'copyBufferToTexture':
      replayCopyBufferToTexture(event, handleMap, encoderMap);
      break;

    case 'copyTextureToBuffer':
      replayCopyTextureToBuffer(event, handleMap, encoderMap);
      break;

    case 'copyTextureToTexture':
      replayCopyTextureToTexture(event, handleMap, encoderMap);
      break;

    case 'clearBuffer':
      replayClearBuffer(event, handleMap, encoderMap);
      break;

    case 'pushDebugGroup':
      replayPushDebugGroup(event, handleMap, encoderMap);
      break;

    case 'popDebugGroup':
      replayPopDebugGroup(event, handleMap, encoderMap);
      break;

    case 'insertDebugMarker':
      replayInsertDebugMarker(event, handleMap, encoderMap);
      break;

    case 'finish':
      replayFinish(event, handleMap, encoderMap);
      break;

    case 'setPipeline':
      replaySetPipeline(event, handleMap, passEncoderMap);
      break;

    case 'setVertexBuffer':
      replaySetVertexBuffer(event, handleMap, passEncoderMap);
      break;

    case 'setIndexBuffer':
      replaySetIndexBuffer(event, handleMap, passEncoderMap);
      break;

    case 'setBindGroup':
      replaySetBindGroup(event, handleMap, passEncoderMap);
      break;

    case 'draw':
      replayDraw(event, passEncoderMap);
      break;

    case 'drawIndexed':
      replayDrawIndexed(event, passEncoderMap);
      break;

    case 'setViewport':
      replaySetViewport(event, passEncoderMap);
      break;

    case 'setScissorRect':
      replaySetScissorRect(event, passEncoderMap);
      break;

    case 'endRenderPass':
      replayEndRenderPass(event, passEncoderMap);
      break;

    case 'setComputePipeline':
      replaySetComputePipeline(event, handleMap, passEncoderMap);
      break;

    case 'dispatchWorkgroups':
      replayDispatchWorkgroups(event, passEncoderMap);
      break;

    case 'endComputePass':
      replayEndComputePass(event, passEncoderMap);
      break;

    default:
      void (event as never);
      break;
  }
}

// ============================================================================
// Per-event-kind replay helpers
// ============================================================================

function replayCreateBuffer(
  event: RhiCallEventCreateBuffer,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const desc: BufferDescriptor = {
    size: event.desc.size,
    usage: event.desc.usage,
    mappedAtCreation: event.desc.mappedAtCreation ?? false,
  };
  const result = device.createBuffer(desc);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateTexture(
  event: RhiCallEventCreateTexture,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const result = device.createTexture(event.desc as any);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateTextureView(
  event: RhiCallEventCreateTextureView,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const texture = handleMap.get(event.sourceHandleId);
  if (texture === undefined) return;
  const result = device.createTextureView(texture as any, event.desc);
  if (result.ok) {
    handleMap.set(event.resultHandleId, result.value);
  }
}

function replayCreateSampler(
  event: RhiCallEventCreateSampler,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const result = device.createSampler(event.desc);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateBindGroupLayout(
  event: RhiCallEventCreateBindGroupLayout,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const result = device.createBindGroupLayout(event.desc as any);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateBindGroup(
  event: RhiCallEventCreateBindGroup,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const layout = handleMap.get(event.layoutHandleId);
  if (layout === undefined) return;

  const entries: Array<{ binding: number; resource: unknown }> = [];
  for (const serialEntry of event.entries) {
    entries.push({ binding: serialEntry.binding, resource: undefined as unknown });
  }

  for (let j = 0; j < event.resourceHandleIds.length && j < entries.length; j++) {
    const resourceHandleId = event.resourceHandleIds[j];
    if (resourceHandleId !== undefined) {
      const resource = handleMap.get(resourceHandleId);
      const entry = entries[j];
      if (resource !== undefined && entry !== undefined) {
        entry.resource = resource;
      }
    }
  }

  const result = device.createBindGroup({ layout, entries } as any);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreatePipelineLayout(
  event: RhiCallEventCreatePipelineLayout,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const bgls: BindGroupLayout[] = [];
  for (const bglId of event.bglHandleIds) {
    const bgl = handleMap.get(bglId);
    if (bgl !== undefined) {
      bgls.push(bgl as any);
    }
  }
  const result = device.createPipelineLayout({ bindGroupLayouts: bgls });
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateRenderPipeline(
  event: RhiCallEventCreateRenderPipeline,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  let layout: PipelineLayout | 'auto' = 'auto';
  if (event.layoutHandleId !== 'layout:auto') {
    const pl = handleMap.get(event.layoutHandleId);
    if (pl !== undefined) {
      layout = pl as any;
    }
  }

  // Build pipeline descriptor with re-created shader modules from handleMap.
  // The tape's event.desc carries live GPU module objects from the recording
  // device; we swap them with shader modules re-created on the replay device
  // via createShaderModuleFn (stored in handleMap under the handleId that
  // the recorder captured as vertexShaderModuleHandleId / fragmentShaderModuleHandleId).
  const desc = { ...event.desc, layout } as Record<string, unknown>;
  if (event.vertexShaderModuleHandleId !== undefined && desc.vertex) {
    const vertexSm = handleMap.get(event.vertexShaderModuleHandleId);
    if (vertexSm !== undefined) {
      (desc.vertex as Record<string, unknown>).module = vertexSm;
    }
  }
  if (event.fragmentShaderModuleHandleId !== undefined && desc.fragment) {
    const fragmentSm = handleMap.get(event.fragmentShaderModuleHandleId);
    if (fragmentSm !== undefined) {
      (desc.fragment as Record<string, unknown>).module = fragmentSm;
    }
  }

  const result = device.createRenderPipeline(desc as any);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateComputePipeline(
  event: RhiCallEventCreateComputePipeline,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  let layout: PipelineLayout | 'auto' = 'auto';
  if (event.layoutHandleId !== 'layout:auto') {
    const pl = handleMap.get(event.layoutHandleId);
    if (pl !== undefined) {
      layout = pl as any;
    }
  }

  // Swap in the re-created compute shader module from handleMap
  // (same cross-device binding reason as replayCreateRenderPipeline).
  const desc = { ...event.desc, layout } as Record<string, unknown>;
  if (event.computeShaderModuleHandleId !== undefined && desc.compute) {
    const computeSm = handleMap.get(event.computeShaderModuleHandleId);
    if (computeSm !== undefined) {
      (desc.compute as Record<string, unknown>).module = computeSm;
    }
  }

  const result = device.createComputePipeline(desc as any);
  if (result.ok) {
    handleMap.set(event.handleId, result.value);
  }
}

function replayCreateCommandEncoder(
  event: RhiCallEventCreateCommandEncoder,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const result = device.createCommandEncoder(event.desc as CommandEncoderDescriptor | undefined);
  if (result.ok) {
    handleMap.set(event.cmdHandleId, result.value);
    encoderMap.set(event.cmdHandleId, result.value);
  }
}

function replayWriteBuffer(
  event: RhiCallEventWriteBuffer,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  tape: Tape,
): void {
  const buffer = handleMap.get(event.handleId);
  if (buffer === undefined) return;

  const data = tape.blobPool.get(event.dataHash);
  if (data === undefined) return;

  queue.writeBuffer(buffer as any, event.bufferOffset, data);
}

function replayWriteTexture(
  event: RhiCallEventWriteTexture,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  tape: Tape,
): void {
  const texture = handleMap.get(event.destination.textureHandleId);
  if (texture === undefined) return;

  const data = tape.blobPool.get(event.dataHash);
  if (data === undefined) return;

  queue.writeTexture(
    {
      texture,
      mipLevel: event.destination.mipLevel,
      origin: event.destination.origin,
      aspect: event.destination.aspect,
    } as any,
    data,
    {
      offset: event.dataLayout.offset ?? 0,
      bytesPerRow: event.dataLayout.bytesPerRow ?? 0,
      rowsPerImage: event.dataLayout.rowsPerImage ?? 0,
    } as any,
    event.size,
  );
}

function replaySubmit(
  event: RhiCallEventSubmit,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
): void {
  const cmdBuffers: unknown[] = [];
  for (const cmdId of event.cmdHandleIds) {
    const cmdBuf = handleMap.get(cmdId);
    if (cmdBuf !== undefined) {
      cmdBuffers.push(cmdBuf);
    }
  }
  if (cmdBuffers.length > 0) {
    queue.submit(cmdBuffers as any);
  }
}

function replayBeginRenderPass(
  event: RhiCallEventBeginRenderPass,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;

  const colorAttachments: Array<Record<string, unknown>> = [];
  let attachIdx = 0;
  const originalAttachments = event.desc.colorAttachments as any;
  for (const attachment of originalAttachments) {
    if (attachment === null || attachment === undefined) {
      colorAttachments.push(attachment as Record<string, unknown>);
    } else {
      const viewHandleId = event.colorAttachmentViewHandleIds[attachIdx];
      const entry: Record<string, unknown> = { ...(attachment as Record<string, unknown>) };
      if (viewHandleId !== undefined && viewHandleId !== null) {
        const view = handleMap.get(viewHandleId);
        if (view !== undefined) {
          entry.view = view;
        }
      }
      colorAttachments.push(entry);
    }
    attachIdx++;
  }

  const desc: Record<string, unknown> = {
    label: (event.desc as { label?: string }).label,
    colorAttachments,
  };

  if (event.depthStencilViewHandleId !== undefined) {
    const dsView = handleMap.get(event.depthStencilViewHandleId);
    if (dsView !== undefined) {
      desc.depthStencilAttachment = {
        ...(event.desc.depthStencilAttachment as any),
        view: dsView,
      };
    }
  }

  const pass = encoder.beginRenderPass(desc as any);
  passEncoderMap.set(event.passHandleId, pass);
}

function replayBeginComputePass(
  event: RhiCallEventBeginComputePass,
  _handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;

  const pass = encoder.beginComputePass(event.desc);
  passEncoderMap.set(event.passHandleId, pass);
}

function replayCopyBufferToBuffer(
  event: RhiCallEventCopyBufferToBuffer,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const src = handleMap.get(event.sourceHandleId);
  const dst = handleMap.get(event.destinationHandleId);
  if (src === undefined || dst === undefined) return;
  encoder.copyBufferToBuffer(
    src as any,
    event.sourceOffset,
    dst as any,
    event.destinationOffset,
    event.size,
  );
}

function replayCopyBufferToTexture(
  event: RhiCallEventCopyBufferToTexture,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const srcBuf = handleMap.get(event.source.bufferHandleId);
  const dstTex = handleMap.get(event.destination.textureHandleId);
  if (srcBuf === undefined || dstTex === undefined) return;

  encoder.copyBufferToTexture(
    { ...event.source, buffer: srcBuf } as any,
    { ...event.destination, texture: dstTex } as any,
    event.copySize,
  );
}

function replayCopyTextureToBuffer(
  event: RhiCallEventCopyTextureToBuffer,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const srcTex = handleMap.get(event.source.textureHandleId);
  const dstBuf = handleMap.get(event.destination.bufferHandleId);
  if (srcTex === undefined || dstBuf === undefined) return;

  encoder.copyTextureToBuffer(
    { ...event.source, texture: srcTex } as any,
    { ...event.destination, buffer: dstBuf } as any,
    event.copySize,
  );
}

function replayCopyTextureToTexture(
  event: RhiCallEventCopyTextureToTexture,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const srcTex = handleMap.get(event.source.textureHandleId);
  const dstTex = handleMap.get(event.destination.textureHandleId);
  if (srcTex === undefined || dstTex === undefined) return;

  encoder.copyTextureToTexture(
    { ...event.source, texture: srcTex } as any,
    { ...event.destination, texture: dstTex } as any,
    event.copySize,
  );
}

function replayClearBuffer(
  event: RhiCallEventClearBuffer,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const buf = handleMap.get(event.handleId);
  if (buf === undefined) return;
  encoder.clearBuffer(buf as any, event.offset, event.size);
}

function replayPushDebugGroup(
  event: RhiCallEventPushDebugGroup,
  _handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  encoder.pushDebugGroup(event.groupLabel);
}

function replayPopDebugGroup(
  event: RhiCallEventPopDebugGroup,
  _handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  encoder.popDebugGroup();
}

function replayInsertDebugMarker(
  event: RhiCallEventInsertDebugMarker,
  _handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  encoder.insertDebugMarker(event.markerLabel);
}

function replayFinish(
  event: RhiCallEventFinish,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
): void {
  const encoder = encoderMap.get(event.cmdHandleId);
  if (encoder === undefined) return;
  const result = encoder.finish();
  if (result.ok) {
    handleMap.set(event.cmdHandleId, result.value);
  }
}

function replaySetPipeline(
  event: RhiCallEventSetPipeline,
  handleMap: Map<HandleId, unknown>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  const pipeline = handleMap.get(event.pipelineHandleId);
  if (pipeline === undefined) return;
  (pass as RhiRenderPassEncoder).setPipeline(pipeline as any);
}

function replaySetVertexBuffer(
  event: RhiCallEventSetVertexBuffer,
  handleMap: Map<HandleId, unknown>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  const buffer = handleMap.get(event.bufferHandleId);
  if (buffer === undefined) return;
  (pass as RhiRenderPassEncoder).setVertexBuffer(
    event.slot,
    buffer as any,
    event.offset ?? 0,
    event.size,
  );
}

function replaySetIndexBuffer(
  event: RhiCallEventSetIndexBuffer,
  handleMap: Map<HandleId, unknown>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  const buffer = handleMap.get(event.bufferHandleId);
  if (buffer === undefined) return;
  (pass as RhiRenderPassEncoder).setIndexBuffer(
    buffer as any,
    event.format,
    event.offset ?? 0,
    event.size,
  );
}

function replaySetBindGroup(
  event: RhiCallEventSetBindGroup,
  handleMap: Map<HandleId, unknown>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  const bg = handleMap.get(event.bindGroupHandleId);
  if (bg === undefined) return;
  pass.setBindGroup(event.index, bg as any, event.dynamicOffsets);
}

function replayDraw(event: RhiCallEventDraw, passEncoderMap: Map<HandleId, PassEncoder>): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).draw(
    event.vertexCount,
    event.instanceCount,
    event.firstVertex,
    event.firstInstance,
  );
}

function replayDrawIndexed(
  event: RhiCallEventDrawIndexed,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).drawIndexed(
    event.indexCount,
    event.instanceCount,
    event.firstIndex,
    event.baseVertex,
    event.firstInstance,
  );
}

function replaySetViewport(
  event: RhiCallEventSetViewport,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).setViewport(
    event.x,
    event.y,
    event.w,
    event.h,
    event.minDepth,
    event.maxDepth,
  );
}

function replaySetScissorRect(
  event: RhiCallEventSetScissorRect,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).setScissorRect(event.x, event.y, event.w, event.h);
}

function replayEndRenderPass(
  event: RhiCallEventEndRenderPass,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).end();
}

function replaySetComputePipeline(
  event: RhiCallEventSetComputePipeline,
  handleMap: Map<HandleId, unknown>,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  const pipeline = handleMap.get(event.pipelineHandleId);
  if (pipeline === undefined) return;
  (pass as RhiComputePassEncoder).setPipeline(pipeline as any);
}

function replayDispatchWorkgroups(
  event: RhiCallEventDispatchWorkgroups,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiComputePassEncoder).dispatchWorkgroups(event.x, event.y, event.z);
}

function replayEndComputePass(
  event: RhiCallEventEndComputePass,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiComputePassEncoder).end();
}

// ============================================================================
// readbackRtImpl (m5b-1)
// ============================================================================

async function replayCreateShaderModule(
  event: RhiCallEventCreateShaderModule,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
  createShaderModuleFn?: CreateShaderModuleFn,
): Promise<void> {
  if (createShaderModuleFn === undefined) return;

  try {
    const result = await createShaderModuleFn(device, { code: event.wgslCode });
    if (result.ok) {
      handleMap.set(event.handleId, result.value);
    }
  } catch {
    // If shader compilation fails on the replay device, leave the handle
    // unmapped. Downstream events (createRenderPipeline) that reference
    // this handle will get undefined and skip.
  }
}

// ============================================================================
// readbackRtImpl (m5b-1)
// ============================================================================

/**
 * Read back render target pixels for a given color attachment index.
 *
 * Walks tape events to find the last beginRenderPass, resolves the
 * colorAttachment[rtIdx] view handleId, walks events again to get real
 * texture dimensions, then performs GPU→host readback via copyTextureToBuffer.
 *
 * Does not modify the replay state (currentEventIdx stays unchanged).
 */
async function readbackRtImpl(
  tape: Tape,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
  rtIdx: number,
): Promise<
  Result<
    {
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8Array;
    },
    DebugError
  >
> {
  // Walk events backwards to find the last beginRenderPass.
  // This is correct because the replay has been stepped through all events
  // by the time the caller invokes readbackRt.
  let lastColorAttachmentHandleIds: string[] | undefined;
  for (let i = tape.events.length - 1; i >= 0; i--) {
    const ev = tape.events[i];
    if (ev !== undefined && ev.kind === 'beginRenderPass') {
      lastColorAttachmentHandleIds = ev.colorAttachmentViewHandleIds as string[];
      break;
    }
  }

  if (lastColorAttachmentHandleIds === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'a beginRenderPass event in tape events',
        hint: 'no beginRenderPass found; the tape may have no render pass',
      }),
    );
  }

  const viewHandleId = lastColorAttachmentHandleIds[rtIdx];
  if (viewHandleId === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `color attachment at index ${rtIdx} to exist`,
        hint: `only ${lastColorAttachmentHandleIds.length} color attachment(s) found`,
      }),
    );
  }

  // Resolve the source texture handleId from the createTextureView event.
  // The viewHandleId from beginRenderPass points to the resultHandleId of
  // createTextureView. copyTextureToBuffer needs a GPUTexture (not a view),
  // so we walk back to the source texture handleId from createTextureView.
  let sourceTextureHandleId: string | undefined;
  for (const ev of tape.events) {
    if (ev !== undefined && ev.kind === 'createTextureView' && ev.resultHandleId === viewHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      break;
    }
  }
  const textureHandleId = sourceTextureHandleId ?? viewHandleId;

  // Resolve the texture from handleMap
  const texture = handleMap.get(textureHandleId);
  const tex = texture as any;
  if (tex === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'color attachment texture was recreated by replay',
        hint: `handleId '${textureHandleId}' (from view '${viewHandleId}') not found in replay handle map`,
      }),
    );
  }

  // Resolve real texture dimensions from createTexture event
  const texSize = resolveAttachmentSize(tape.events, viewHandleId);

  let pixels: Uint8Array;
  try {
    pixels = await readbackTexturePixels(device, tex, texSize.width, texSize.height);
  } catch (e) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'texture readback to succeed',
        hint: `GPU readback failed: ${String(e)}`,
      }),
    );
  }

  return ok({ width: texSize.width, height: texSize.height, pixels });
}
