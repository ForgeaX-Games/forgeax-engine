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
import { findEventIdxForDraw } from './inspect-core';
import { readbackTexturePixels, resolveAttachmentSize } from './readback';
import type { CreateShaderModuleFn } from './recorder';
import { computeTextureLayout } from './texel-layout';
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
  RhiCallEventDrawIndexedIndirect,
  RhiCallEventDrawIndirect,
  RhiCallEventEndComputePass,
  RhiCallEventEndRenderPass,
  RhiCallEventFinish,
  RhiCallEventInitialData,
  RhiCallEventInsertDebugMarker,
  RhiCallEventPassInsertDebugMarker,
  RhiCallEventPassPopDebugGroup,
  RhiCallEventPassPushDebugGroup,
  RhiCallEventPopDebugGroup,
  RhiCallEventPushDebugGroup,
  RhiCallEventSetBindGroup,
  RhiCallEventSetBlendConstant,
  RhiCallEventSetComputePipeline,
  RhiCallEventSetIndexBuffer,
  RhiCallEventSetPipeline,
  RhiCallEventSetScissorRect,
  RhiCallEventSetStencilReference,
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
  textureCompressionBc: 'texture-compression-bc',
  textureCompressionEtc2: 'texture-compression-etc2',
  textureCompressionAstc: 'texture-compression-astc',
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
   * Replay forward and leave the target draw's color attachment COMMITTED with
   * the cumulative state right after global draw #drawIdx executes.
   *
   * Unlike `stepTo` (which replays raw events and leaves an open, uncommitted
   * render pass when it stops mid-pass — a color attachment cannot be read
   * mid-pass per WebGPU), this replays every event up to & including the target
   * draw, then SYNTHESIZES endRenderPass + finish + submit on the target pass's
   * recorded encoder so the attachment holds committed pixels. Earlier passes
   * are committed by their own recorded submit events replayed along the way.
   *
   * After a successful `{committed:true}` return, `readbackDrawRt(drawIdx)` (or
   * the inspector's RT readback) reads exactly the draws-0..N pixels — so two
   * different draws in one pass yield different images.
   *
   * Monotonic-forward like `stepTo`: to re-target an earlier draw, call
   * `reset()` first (the per-draw consumers already do).
   *
   * @param drawIdx - Global draw index (Nth draw/dispatch in the tape).
   * @returns Ok({committed:true}) when the target pass has a color attachment
   *   and was committed; Ok({committed:false}) when the draw is in a depth-only
   *   render pass or a compute pass (no color RT to show — consumers render a
   *   "no-rt" state); Err 'replay-step-out-of-range' on an out-of-range or
   *   non-monotonic drawIdx, or 'rt-readback-failed' when the recorded pass /
   *   encoder handles cannot be resolved.
   */
  readonly commitThroughDraw: (
    drawIdx: number,
  ) => Promise<Result<{ readonly committed: boolean }, DebugError>>;

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
      // Clear command/pass encoder maps too: after reset, currentIdx returns to
      // 0 and the next replay re-runs createCommandEncoder/beginRenderPass, so
      // stale encoders/passes from the prior run must not linger (commitThrough-
      // Draw resolves the open pass via these maps).
      encoderMap.clear();
      passEncoderMap.clear();
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

    commitThroughDraw(
      drawIdx: number,
    ): Promise<Result<{ readonly committed: boolean }, DebugError>> {
      return commitThroughDrawImpl(
        tape,
        device,
        deviceQueue,
        handleMap,
        encoderMap,
        passEncoderMap,
        drawIdx,
        () => _currentEventIdx,
        (v: number) => {
          _currentEventIdx = v;
        },
        () => _disposed,
        createShaderModuleFn,
      );
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
  readonly textureCompressionBc: boolean;
  readonly textureCompressionEtc2: boolean;
  readonly textureCompressionAstc: boolean;
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
  if (recorded.textureCompressionBc && !targetCaps.textureCompressionBc) {
    missing.push('textureCompressionBc');
  }
  if (recorded.textureCompressionEtc2 && !targetCaps.textureCompressionEtc2) {
    missing.push('textureCompressionEtc2');
  }
  if (recorded.textureCompressionAstc && !targetCaps.textureCompressionAstc) {
    missing.push('textureCompressionAstc');
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

    const replayResult = await replayEvent(
      event,
      tape,
      device,
      queue,
      handleMap,
      encoderMap,
      passEncoderMap,
      createShaderModuleFn,
    );
    // Fail Fast (architecture §5): a seed failure (or any future Result-
    // returning event handler) stops replay immediately rather than advancing
    // currentIdx over an unseeded resource.
    if (!replayResult.ok) return replayResult;
    setCurrentIdx(i + 1);
  }

  return ok(undefined);
}

// ============================================================================
// commitThroughDrawImpl — per-draw cumulative RT commit
// ============================================================================

/**
 * Replay through global draw #drawIdx and synthetically commit the enclosing
 * render pass so its color attachment holds the draws-0..N cumulative pixels.
 * See Replay.commitThroughDraw for the contract.
 */
async function commitThroughDrawImpl(
  tape: Tape,
  device: RhiDevice,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
  drawIdx: number,
  getCurrentIdx: () => number,
  setCurrentIdx: (v: number) => void,
  getDisposed: () => boolean,
  createShaderModuleFn?: CreateShaderModuleFn,
): Promise<Result<{ readonly committed: boolean }, DebugError>> {
  const events = tape.events;
  const totalEvents = events.length;

  const outOfRange = (hint: string): Result<{ readonly committed: boolean }, DebugError> =>
    err(
      new DebugError({
        code: 'replay-step-out-of-range',
        expected: 'drawIdx in range and >= current replay position',
        hint,
        detail: { requestedStep: drawIdx, currentStep: getCurrentIdx(), totalEvents },
      }),
    );

  if (getDisposed()) {
    return outOfRange('Replay is already disposed; create a new Replay session');
  }

  // Map global draw -> event index (shared SSOT helper).
  const targetEventIdx = findEventIdxForDraw(events, drawIdx);
  if (targetEventIdx === -1) {
    return outOfRange(`drawIdx ${drawIdx} is out of range; tape has fewer draw/dispatch calls`);
  }
  // Monotonic-forward, same contract as stepTo.
  if (targetEventIdx < getCurrentIdx()) {
    return outOfRange(
      `cannot commit backward from event ${getCurrentIdx()} to draw ${drawIdx} ` +
        `(event ${targetEventIdx}); call reset() first`,
    );
  }

  // Walk back to the enclosing pass. A render pass commits a color attachment;
  // a compute pass (or a depth-only render pass) has no color RT to show.
  let beginEv: RhiCallEventBeginRenderPass | undefined;
  for (let i = targetEventIdx; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.kind === 'beginRenderPass') {
      beginEv = ev;
      break;
    }
    if (ev.kind === 'beginComputePass') {
      // Compute dispatch: nothing to render-commit; let the caller show no-rt.
      // Still advance replay through the dispatch for state consistency.
      const fwd = await replayForward(
        events,
        targetEventIdx,
        tape,
        device,
        queue,
        handleMap,
        encoderMap,
        passEncoderMap,
        getCurrentIdx,
        setCurrentIdx,
        createShaderModuleFn,
      );
      if (!fwd.ok) return fwd;
      return ok({ committed: false });
    }
  }
  if (beginEv === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'a beginRenderPass enclosing the target draw',
        hint: `no beginRenderPass found before draw ${drawIdx} (event ${targetEventIdx})`,
      }),
    );
  }

  // Depth-only pass: no color attachment to commit.
  const hasColor =
    beginEv.colorAttachmentViewHandleIds.some((id) => id !== undefined && id !== null) &&
    Array.from(beginEv.desc.colorAttachments).some((a) => a !== undefined && a !== null);

  // Replay forward up to & including the target draw (earlier passes commit via
  // their own recorded submit; interleaved writeBuffer events replay in order).
  const fwd = await replayForward(
    events,
    targetEventIdx,
    tape,
    device,
    queue,
    handleMap,
    encoderMap,
    passEncoderMap,
    getCurrentIdx,
    setCurrentIdx,
    createShaderModuleFn,
  );
  if (!fwd.ok) return fwd;

  // Synthetic commit of the (still-open) target pass, derived from beginEv's
  // recorded handles — mirrors replayEndRenderPass + replayFinish + replaySubmit
  // but stops at the target draw instead of replaying the recorded pass tail.
  //
  // This runs for depth-only passes too (shadow / depth pre-pass, no color
  // attachment): without it the target draw's depth writes were never flushed, so
  // every draw in the pass read back the SAME final depth and the depth preview
  // only changed at the next pass boundary. `committed` still reflects hasColor —
  // it means "a color RT was committed" (the depth path reads the texture directly
  // via _resolveHandle, not through this flag).
  const pass = passEncoderMap.get(beginEv.passHandleId);
  if (pass === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'the target render pass encoder to be open at the target draw',
        hint: `pass '${beginEv.passHandleId}' not found in replay pass map`,
      }),
    );
  }
  (pass as RhiRenderPassEncoder).end();

  const encoder = encoderMap.get(beginEv.cmdHandleId);
  if (encoder === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'the target command encoder to exist at the target draw',
        hint: `encoder '${beginEv.cmdHandleId}' not found in replay encoder map`,
      }),
    );
  }
  const finishRes = encoder.finish();
  if (!finishRes.ok) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'synthetic encoder.finish() to succeed',
        hint: `finish failed: ${finishRes.error.code}`,
      }),
    );
  }
  handleMap.set(beginEv.cmdHandleId, finishRes.value);
  queue.submit([finishRes.value as unknown as never] as unknown as readonly never[]);
  await queue.onSubmittedWorkDone();

  return ok({ committed: hasColor });
}

/**
 * Replay events[currentIdx..targetEventIdx] inclusive (Fail-Fast on any event
 * error). Shared by commitThroughDrawImpl's render and compute arms.
 */
async function replayForward(
  events: readonly RhiCallEvent[],
  targetEventIdx: number,
  tape: Tape,
  device: RhiDevice,
  queue: RhiQueue,
  handleMap: Map<HandleId, unknown>,
  encoderMap: Map<HandleId, RhiCommandEncoder>,
  passEncoderMap: Map<HandleId, PassEncoder>,
  getCurrentIdx: () => number,
  setCurrentIdx: (v: number) => void,
  createShaderModuleFn?: CreateShaderModuleFn,
): Promise<Result<{ readonly committed: boolean }, DebugError>> {
  for (let i = getCurrentIdx(); i <= targetEventIdx; i++) {
    const event = events[i];
    if (event === undefined) break;
    const res = await replayEvent(
      event,
      tape,
      device,
      queue,
      handleMap,
      encoderMap,
      passEncoderMap,
      createShaderModuleFn,
    );
    if (!res.ok) return res as unknown as Result<{ readonly committed: boolean }, DebugError>;
    setCurrentIdx(i + 1);
  }
  return ok({ committed: false });
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
): Promise<Result<void, DebugError>> {
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

    case 'setStencilReference':
      replaySetStencilReference(event, passEncoderMap);
      break;

    case 'endRenderPass':
      replayEndRenderPass(event, passEncoderMap);
      break;

    case 'setBlendConstant':
      replaySetBlendConstant(event, passEncoderMap);
      break;

    case 'passPushDebugGroup':
      replayPassPushDebugGroup(event, passEncoderMap);
      break;

    case 'passPopDebugGroup':
      replayPassPopDebugGroup(event, passEncoderMap);
      break;

    case 'passInsertDebugMarker':
      replayPassInsertDebugMarker(event, passEncoderMap);
      break;

    case 'drawIndirect':
      replayDrawIndirect(event, passEncoderMap);
      break;

    case 'drawIndexedIndirect':
      replayDrawIndexedIndirect(event, passEncoderMap);
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

    case 'initialData': {
      // Seed handler returns Result — bubble it so stepToImpl fails fast on a
      // seed miss rather than silently leaving the resource unseeded (D-3, R6,
      // architecture §5 Fail Fast).
      const seed = replayInitialData(event, tape, handleMap, queue);
      if (!seed.ok) return seed;
      break;
    }

    default:
      void (event as never);
      break;
  }

  return ok(undefined);
}

// ============================================================================
// Cross-backend format adaptation (F-1)
// ============================================================================

/**
 * Adapt a recorded canvas swapchain format to one the offline replay device
 * accepts for an ordinary (non-swapchain) texture and its view.
 *
 * **Why this is a target-device format adaptation, not a synthetic value (C-3):**
 * a browser captures the canvas swapchain as a `bgra8unorm` texture but views it
 * (and the render-pipeline color target) as `bgra8unorm-srgb` — the srgb view of
 * the platform's preferred canvas format. When that tape is replayed offline, the
 * swapchain texture is reconstructed as an ordinary offscreen texture. The plain
 * `bgra8unorm` texture is creatable, but a `bgra8unorm-srgb` *view* over it is not
 * valid unless the texture declared `viewFormats: ['bgra8unorm-srgb']` (which the
 * canvas-provided swapchain texture implies but a manually-created texture does
 * not). Replaying the recorded shape verbatim therefore fails at `beginRenderPass`
 * with an incompatible-view-format error. This is a genuine cross-backend
 * impedance, not a recording defect: the recorded formats are faithful, but the
 * offline replay device cannot reconstruct the canvas's implicit srgb-view
 * compatibility on a plain texture.
 *
 * The remap rewrites the canvas BGRA formats to their byte-compatible RGBA
 * counterparts, **preserving srgb-ness**: `bgra8unorm` -> `rgba8unorm` and
 * `bgra8unorm-srgb` -> `rgba8unorm-srgb`. Preserving srgb is required for pixel
 * fidelity: the live canvas is a `bgra8unorm` surface viewed as `bgra8unorm-srgb`,
 * so the render encodes to srgb on store and `getImageData` reads srgb bytes.
 * Replaying the color view + pipeline target as srgb makes the offline render
 * encode identically, so `readbackRt` reads matching bytes. Collapsing srgb to
 * plain `rgba8unorm` (the earlier shape) dropped that encode and left the replay
 * uniformly ~0.046 darker than the demo (a visible, not cosmetic, gap).
 *
 * The reconstructed swapchain TEXTURE stays a plain `rgba8unorm` storage texture
 * (its recorded create event has no srgb format); `replayCreateTexture` declares
 * `viewFormats: ['rgba8unorm-srgb']` on it so the srgb VIEW is valid over the
 * non-srgb storage. All three (texture storage / view / pipeline target) then
 * agree the way the live canvas does. Every other format -- including
 * `rgba8unorm` itself -- passes through unchanged.
 *
 * This adaptation is replay-layer-generic (every browser-captured tape replayed
 * offline needs it), which is why it lives here rather than in any per-demo script.
 */
export function adaptReplayFormat(format: string | undefined): string | undefined {
  if (format === 'bgra8unorm-srgb') return 'rgba8unorm-srgb';
  if (format === 'bgra8unorm') return 'rgba8unorm';
  return format;
}

/**
 * True for the exact bgra8 formats `adaptReplayFormat` rewrites to rgba8 — i.e.
 * the textures whose REPLAY storage has its R/B swapped relative to the recorded
 * source. Their initialData seed bytes (raw BGRA) must be R/B-swapped to land
 * correctly in the recreated RGBA texture. Only these two 4-byte formats qualify;
 * every other snapshottable format keeps native channel order on replay.
 */
function isBgraSeedFormat(format: GPUTextureFormat | undefined): boolean {
  return format === 'bgra8unorm' || format === 'bgra8unorm-srgb';
}

/**
 * Swap the R and B channels of every RGBA8/BGRA8 texel in place (stride 4,
 * bytes [0] <-> [2]). Trailing bytes that do not complete a 4-byte texel are
 * left untouched (tight-packed snapshot slices are always texel-aligned). Returns
 * the same array for call-site chaining.
 */
function swapRedBlueInPlace(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const r = bytes[i] as number;
    bytes[i] = bytes[i + 2] as number;
    bytes[i + 2] = r;
  }
  return bytes;
}

/**
 * Ensure a reconstructed texture descriptor can host an srgb view. When the
 * (adapted) storage format is plain `rgba8unorm`, the replayed color view may be
 * `rgba8unorm-srgb` (see adaptReplayFormat); that view is only legal if the
 * texture declares the srgb format in `viewFormats`. The live canvas implies this
 * compatibility for its swapchain texture, but a manually-recreated texture must
 * state it explicitly. Idempotent: adds the entry only when missing.
 */
function withSrgbViewFormat<T extends { format?: unknown; viewFormats?: unknown }>(desc: T): T {
  if (desc.format !== 'rgba8unorm') return desc;
  const existing = Array.isArray(desc.viewFormats) ? (desc.viewFormats as unknown[]) : [];
  if (existing.includes('rgba8unorm-srgb')) return desc;
  return { ...desc, viewFormats: [...existing, 'rgba8unorm-srgb'] };
}

/**
 * Return a copy of `desc` with its `format` field remapped via
 * `adaptReplayFormat`, or the original `desc` unchanged when the format needs
 * no adaptation (so the same-format replay path allocates nothing extra).
 * Shared by the createTexture / createTextureView handlers.
 *
 * `viewFormats` is remapped in lockstep: a texture recorded as
 * `{ format: 'bgra8unorm', viewFormats: ['bgra8unorm-srgb'] }` becomes invalid
 * if only `.format` is rewritten to `rgba8unorm` while `viewFormats` keeps the
 * BGRA srgb entry (CreateTexture rejects with "viewFormats[0] not compatible
 * with the texture format"). Rewriting both keeps the descriptor self-consistent
 * and lets the subsequent initialData WriteTexture seed land on a valid texture.
 */
function descWithAdaptedFormat<T extends { format?: unknown; viewFormats?: unknown }>(desc: T): T {
  const adaptedFormat = adaptReplayFormat(desc.format as string | undefined);

  let adaptedViewFormats: unknown = desc.viewFormats;
  let viewFormatsChanged = false;
  const originalViewFormats = desc.viewFormats;
  if (Array.isArray(originalViewFormats)) {
    const remapped = originalViewFormats.map((f) => adaptReplayFormat(f as string | undefined));
    viewFormatsChanged = remapped.some((f, i) => f !== originalViewFormats[i]);
    if (viewFormatsChanged) adaptedViewFormats = remapped;
  }

  if (adaptedFormat === desc.format && !viewFormatsChanged) return desc;
  return { ...desc, format: adaptedFormat, viewFormats: adaptedViewFormats };
}

/**
 * Remap the color-target formats of a render-pipeline fragment state via
 * `adaptReplayFormat`. Returns a new fragment object when any target changed,
 * `undefined` when nothing needs adapting (so the caller leaves the original
 * fragment untouched).
 */
function adaptFragmentTargets(fragment: unknown): Record<string, unknown> | undefined {
  if (!fragment || typeof fragment !== 'object') return undefined;
  const frag = fragment as Record<string, unknown>;
  if (!Array.isArray(frag.targets)) return undefined;

  let mutated = false;
  const adaptedTargets = frag.targets.map((t: unknown) => {
    if (!t || typeof t !== 'object' || !('format' in t)) return t;
    const target = t as Record<string, unknown>;
    const adapted = adaptReplayFormat(target.format as string | undefined);
    if (adapted === target.format) return t;
    mutated = true;
    return { ...target, format: adapted };
  });

  return mutated ? { ...frag, targets: adaptedTargets } : undefined;
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

// GPUTextureUsage.COPY_DST — a recreated texture must accept queue.writeTexture
// to be seeded from its initialData event. Some source textures (e.g. an
// r32float LUT recorded with RENDER_ATTACHMENT|COPY_SRC|TEXTURE_BINDING) lack
// COPY_DST; without promoting it here the seed's writeTexture is rejected.
// COPY_SRC is NOT promoted here: the recorder (recorder.ts createTexture) is the
// SSOT for it — every recorded createTexture event already carries COPY_SRC so
// snapshot/readback can copyTextureToBuffer the resource. This is what lets the
// inspector's TextureViewer read back bound input textures after replay.
const TEXTURE_USAGE_COPY_DST = 0x02;
// GPUTextureUsage.TEXTURE_BINDING — promoted ONLY for depth/stencil-format textures
// so the inspector's TextureViewer can sample (textureLoad) the depth plane of a
// non-copyable depth format (depth24plus*) in a blit pass: WebGPU forbids
// copyTextureToBuffer on that plane, so the only faithful way to read its real
// values is to sample it. Widening usage does not change rendered depth values;
// restricted to depth formats to avoid touching color textures.
const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;

function replayCreateTexture(
  event: RhiCallEventCreateTexture,
  device: RhiDevice,
  handleMap: Map<HandleId, unknown>,
): void {
  const adapted = withSrgbViewFormat(descWithAdaptedFormat(event.desc));
  const isDepthFormat =
    typeof event.desc.format === 'string' && event.desc.format.includes('depth');
  const usage =
    ((adapted.usage as number | undefined) ?? 0) |
    TEXTURE_USAGE_COPY_DST |
    (isDepthFormat ? TEXTURE_USAGE_TEXTURE_BINDING : 0);
  const seedableDesc = { ...adapted, usage };
  const result = device.createTexture(seedableDesc as any);
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
  const result = device.createTextureView(texture as any, descWithAdaptedFormat(event.desc) as any);
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
      const resourceKind = event.entries[j]?.resourceKind;
      if (resource !== undefined && entry !== undefined) {
        // Re-wrap raw Rhi objects into RhiBindingResource shape
        // so rhi-webgpu.createBindGroup can dispatch on .kind.
        if (resourceKind === 'buffer') {
          // Preserve the recorded sub-range so a dynamic-offset slice binds
          // `bufferSize` bytes rather than the whole buffer (the latter
          // exceeds the device uniform/storage binding-size limit).
          const serial = event.entries[j];
          const value: { buffer: unknown; offset?: number; size?: number } = { buffer: resource };
          if (serial?.bufferOffset !== undefined) value.offset = serial.bufferOffset;
          if (serial?.bufferSize !== undefined) value.size = serial.bufferSize;
          entry.resource = { kind: 'buffer', value };
        } else if (resourceKind === 'sampler') {
          entry.resource = { kind: 'sampler', value: resource };
        } else if (resourceKind === 'textureView') {
          entry.resource = { kind: 'textureView', value: resource };
        } else {
          entry.resource = resource;
        }
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
  // F-1: adapt fragment color-target formats so the pipeline's attachment
  // state matches the replay-adapted RT texture/view formats (canvas BGRA ->
  // rgba8unorm). A render pipeline whose target format diverges from its bound
  // color attachment is rejected, so this mirrors the createTexture /
  // createTextureView remap above.
  const adaptedFragment = adaptFragmentTargets(desc.fragment);
  if (adaptedFragment !== undefined) {
    desc.fragment = adaptedFragment;
  }
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

function replaySetStencilReference(
  event: RhiCallEventSetStencilReference,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).setStencilReference(event.reference);
}

function replayEndRenderPass(
  event: RhiCallEventEndRenderPass,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  (pass as RhiRenderPassEncoder).end();
}

// -- New handlers (M3 w11) --

function replaySetBlendConstant(
  event: RhiCallEventSetBlendConstant,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  // Only render pass encoders have setBlendConstant; compute pass silently skipped
  // because passEncoderMap.get returns undefined for compute-only pass handles
  // that were never registered as render passes.
  (pass as RhiRenderPassEncoder).setBlendConstant(event.color);
}

function replayPassPushDebugGroup(
  event: RhiCallEventPassPushDebugGroup,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  // Compute pass encoders do not have pushDebugGroup (GPUDebugCommandsMixin
  // is bound to render pass only per WebGPU spec). Check method presence
  // instead of type-narrowing: RhiComputePassEncoder lacks the debug mixin.
  if (typeof (pass as any).pushDebugGroup !== 'function') return;
  (pass as RhiRenderPassEncoder).pushDebugGroup(event.groupLabel);
}

function replayPassPopDebugGroup(
  event: RhiCallEventPassPopDebugGroup,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  if (typeof (pass as any).popDebugGroup !== 'function') return;
  (pass as RhiRenderPassEncoder).popDebugGroup();
}

function replayPassInsertDebugMarker(
  event: RhiCallEventPassInsertDebugMarker,
  passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  const pass = passEncoderMap.get(event.passHandleId);
  if (pass === undefined) return;
  if (typeof (pass as any).insertDebugMarker !== 'function') return;
  (pass as RhiRenderPassEncoder).insertDebugMarker(event.markerLabel);
}

function replayDrawIndirect(
  _event: RhiCallEventDrawIndirect,
  _passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  // Indirect buffer bytes are not available (not in blobPool/initialData).
  // Silently skip precise replay; Pipeline State is still extractable from
  // the original event for viewer consumption. The draw that followed this
  // event in the original frame is not replayed, but subsequent events are.
}

function replayDrawIndexedIndirect(
  _event: RhiCallEventDrawIndexedIndirect,
  _passEncoderMap: Map<HandleId, PassEncoder>,
): void {
  // Same as drawIndirect: buffer content unavailable -> skip precise replay.
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
// replayInitialData — seed handler (M1 signature stub)
// ============================================================================

/**
 * Resolve whether an initialData handleId names a buffer or a texture by
 * scanning the tape's create* events. The initialData event carries only
 * {handleId, dataHash} (shape lives in the descriptor registry at record time,
 * not duplicated on the wire, types.ts SSOT) — so the replay side reads the
 * kind back from the createBuffer / createTexture event that declared the
 * handle in the bootstrap prefix.
 */
function resolveInitialDataKind(
  events: readonly RhiCallEvent[],
  handleId: HandleId,
): 'buffer' | 'texture' | undefined {
  for (const ev of events) {
    if (ev.kind === 'createBuffer' && ev.handleId === handleId) return 'buffer';
    if (ev.kind === 'createTexture' && ev.handleId === handleId) return 'texture';
  }
  return undefined;
}

/**
 * Seed a recreated resource with its recorded initial bytes.
 *
 * Called during replay when the event stream reaches an initialData event
 * (positioned after all create* events in the bootstrap prefix). Looks up
 * the recreated resource from handleMap, fetches its bytes from the tape's
 * blobPool via dataHash, resolves the resource kind from the tape's create*
 * events, and writes the bytes into the resource via queue.writeBuffer (buffer)
 * or queue.writeTexture (texture).
 *
 * Returns Result<void, DebugError> — failures bubble up through stepToImpl
 * (not void-silently-return, per D-3 / AC-07). `seed-initial-data-failed`
 * carries `.detail = {handleId, stage}` where stage is 'lookup' (handleMap /
 * blobPool / kind miss) or 'write' (queue.writeBuffer / writeTexture threw).
 * On success the resource contains the exact bytes captured at recording time.
 */
export function replayInitialData(
  event: RhiCallEventInitialData,
  tape: Tape,
  handleMap: Map<HandleId, unknown>,
  queue: RhiQueue,
): Result<void, DebugError> {
  const seedFail = (stage: 'lookup' | 'write', hint: string): Result<void, DebugError> =>
    err(
      new DebugError({
        code: 'seed-initial-data-failed',
        expected: 'replayInitialData to seed the recreated resource with its recorded bytes',
        hint,
        detail: { handleId: event.handleId, stage },
      }),
    );

  const resource = handleMap.get(event.handleId);
  if (resource === undefined) {
    return seedFail(
      'lookup',
      `handleId '${event.handleId}' not found in handleMap; its create* event must replay before the initialData seed`,
    );
  }

  const data = tape.blobPool.get(event.dataHash);
  if (data === undefined) {
    return seedFail(
      'lookup',
      `dataHash '${event.dataHash}' not found in tape.blobPool for handleId '${event.handleId}'`,
    );
  }

  const kind = resolveInitialDataKind(tape.events, event.handleId);
  if (kind === undefined) {
    return seedFail(
      'lookup',
      `no createBuffer/createTexture event declares handleId '${event.handleId}'; cannot determine whether to writeBuffer or writeTexture`,
    );
  }

  try {
    if (kind === 'buffer') {
      queue.writeBuffer(resource as any, 0, data);
    } else {
      const shape = resolveTextureShape(tape.events, event.handleId);
      const layout = computeTextureLayout(
        shape.format,
        shape.width,
        shape.height,
        shape.layerCount,
        shape.mipLevelCount,
      );
      if (layout === undefined) {
        // The recorder gate only snapshots formats with a known texel size, so a
        // texture initialData event should always have a computable layout.
        return seedFail(
          'write',
          `texture '${event.handleId}' has format '${shape.format}' with no byte layout; cannot seed`,
        );
      }
      // Walk the same canonical (layer, mip) order the snapshot used: each slice
      // is tight-packed in the blob at slice.byteOffset; writeTexture it back to
      // its (mipLevel, baseArrayLayer) with bytesPerRow = mipWidth * bytesPerTexel.
      const dataBytes = new Uint8Array(data);
      // Channel-order fidelity (sibling of bug #3 on the seed path): a texture
      // recorded as bgra8unorm[-srgb] is recreated by replayCreateTexture as
      // rgba8unorm[-srgb] (adaptReplayFormat swaps R/B in the FORMAT, since the
      // offline device cannot reconstruct the canvas's implicit BGRA surface).
      // But the snapshot blob holds the source's raw BGRA bytes. Uploading them
      // verbatim into the RGBA-format texture swaps R<->B for every texel — a
      // pre-arm sampled bgra texture (e.g. the FXAA composite source) then tints
      // the whole frame (orange floor -> purple). Swap R/B in the seed bytes to
      // match the adapted format so the sampled texel reads identically.
      const seededBytes = isBgraSeedFormat(shape.format)
        ? swapRedBlueInPlace(dataBytes.slice())
        : dataBytes;
      for (const slice of layout.slices) {
        const sliceData = seededBytes.subarray(
          slice.byteOffset,
          slice.byteOffset + slice.byteLength,
        );
        queue.writeTexture(
          {
            texture: resource,
            mipLevel: slice.mip,
            origin: { x: 0, y: 0, z: slice.layer },
          } as any,
          sliceData,
          {
            offset: 0,
            bytesPerRow: slice.width * layout.bytesPerTexel,
            rowsPerImage: slice.height,
          } as any,
          { width: slice.width, height: slice.height, depthOrArrayLayers: 1 },
        );
      }
    }
  } catch (e) {
    return seedFail(
      'write',
      `queue.${kind === 'buffer' ? 'writeBuffer' : 'writeTexture'} threw for handleId '${event.handleId}': ${String(e)}`,
    );
  }

  return ok(undefined);
}

/**
 * Resolve a texture's full snapshot shape (extent + format + layers + mips) from
 * its createTexture event, so the seed walks the identical layout the snapshot
 * readback produced (architecture-principles #1 SSOT: the createTexture event is
 * the single source for shape; seed and readback both derive from it). Falls back
 * to a 1x1 single-layer single-mip rgba8 layout when the create event is absent
 * (seed lookup already guards the missing-create case before this is reached).
 */
function resolveTextureShape(
  events: readonly RhiCallEvent[],
  handleId: HandleId,
): {
  width: number;
  height: number;
  layerCount: number;
  mipLevelCount: number;
  format: GPUTextureFormat | undefined;
} {
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === handleId) {
      const sz = ev.desc.size;
      let width = 1;
      let height = 1;
      let layerCount = 1;
      if (Array.isArray(sz)) {
        width = typeof sz[0] === 'number' ? sz[0] : 1;
        height = typeof sz[1] === 'number' ? sz[1] : width;
        layerCount = typeof sz[2] === 'number' ? sz[2] : 1;
      } else {
        const obj = sz as { width: number; height?: number; depthOrArrayLayers?: number };
        width = typeof obj.width === 'number' ? obj.width : 1;
        height = typeof obj.height === 'number' ? obj.height : width;
        layerCount = typeof obj.depthOrArrayLayers === 'number' ? obj.depthOrArrayLayers : 1;
      }
      return {
        width,
        height,
        layerCount,
        mipLevelCount: ev.desc.mipLevelCount ?? 1,
        format: ev.desc.format as GPUTextureFormat | undefined,
      };
    }
  }
  return { width: 1, height: 1, layerCount: 1, mipLevelCount: 1, format: undefined };
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
