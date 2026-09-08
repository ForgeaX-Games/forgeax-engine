// @forgeax/engine-rhi-debug/src/recorder/core -- recorder state and event ownership.

/// <reference types="@webgpu/types" />

import type {
  Result,
  RhiDevice,
  RhiInstance,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { textureBlockLayout } from '../texel-layout';
import type { HandleId, RhiCallEvent, RhiCapsRecorded, Tape } from '../types';
import { _getCreateEventReferencedHandleIds } from './closure';

const SNAPSHOT_TIMEOUT_MS = 30_000;

// Result factories `makeOk` / `makeErr` re-import the canonical
// `ok` / `err` from `@forgeax/engine-types` (architecture-principles #1
// SSOT — same shape, same factory, no inline duplicate). Aliased on
// import to avoid a free-form rename diff in this file's existing
// `makeOk(...)` / `makeErr(...)` call sites; semantics identical.

// ============================================================================
// Constants
// ============================================================================

export const PER_EVENT_OVERHEAD = 192 as const;

// COPY_SRC promotion bit values (D-5). GPUBufferUsage and GPUTextureUsage have
// DIFFERENT bit layouts — COPY_SRC is 0x04 for buffers but 0x01 for textures:
//   GPUBufferUsage:  MAP_READ=0x01 MAP_WRITE=0x02 COPY_SRC=0x04 COPY_DST=0x08 ...
//   GPUTextureUsage: COPY_SRC=0x01 COPY_DST=0x02 TEXTURE_BINDING=0x04 ...
// A buffer carrying MAP_READ / MAP_WRITE cannot also carry COPY_SRC (WebGPU
// validation: a mappable buffer's only other allowed usage is the matching
// COPY_DST / COPY_SRC), so promotion is skipped for mappable buffers — those
// are staging buffers, never frame-header snapshot targets.
const BUFFER_USAGE_COPY_SRC = 0x04;
const BUFFER_USAGE_MAP_READ = 0x01;
const BUFFER_USAGE_MAP_WRITE = 0x02;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_COPY_DST = 0x02;
const TEXTURE_USAGE_BINDING = 0x04;
/** Bound staging allocation, command submission, and map concurrency per batch. */
export const SNAPSHOT_RESOURCE_BATCH_SIZE = 32;

/**
 * True for each depth / stencil texture format. Their content is render-pass
 * output (shadow maps, z-buffers), never an uploaded byte payload, and
 * queue.writeTexture rejects them (no CopyDst), so the frame-header snapshot
 * loop skips them rather than emitting an un-seedable initialData event.
 */
function isDepthOrStencilFormat(format: GPUTextureFormat | undefined): boolean {
  return format !== undefined && (format.startsWith('depth') || format.startsWith('stencil'));
}

/**
 * True for a texture the frame-header snapshot can read back AND re-seed
 * faithfully: each color format with a known texel-block footprint, at each
 * array-layer count and each mip count. The readback + seed path
 * (readbackTexturePixels + computeTextureLayout + replayInitialData) walks
 * every (layer, mip) subresource with block-aware bytesPerRow, so ordinary
 * texels and BC/ETC/ASTC compressed assets share one round-trip contract.
 *
 * Still skipped (no faithful path today, Fail Fast rather than corrupt seed):
 * - depth/stencil formats: queue.writeTexture rejects them (no CopyDst seed).
 * - multisample (sampleCount > 1): writeTexture rejects an MSAA target. MSAA
 *   attachments are transient (resolved into a single-sample texture that IS
 *   snapshottable), so skipping loses no seed.
 */
function isSnapshottableColorTexture(
  format: GPUTextureFormat | undefined,
  _size: number | GPUExtent3DStrict | undefined,
  sampleCount?: number,
): boolean {
  if (isDepthOrStencilFormat(format)) return false;
  // Multisample textures reject queue.writeTexture; skip (resolved target seeds).
  if (sampleCount !== undefined && sampleCount > 1) return false;
  // Round-trippable iff its texel-block footprint is known.
  return textureBlockLayout(format) !== undefined;
}

/** Add COPY_SRC to a buffer usage unless it is a mappable (MAP_READ/WRITE) buffer. */
function promoteBufferUsage(usage: number): number {
  if ((usage & (BUFFER_USAGE_MAP_READ | BUFFER_USAGE_MAP_WRITE)) !== 0) return usage;
  return usage | BUFFER_USAGE_COPY_SRC;
}

/**
 * True for a mappable (MAP_READ / MAP_WRITE) buffer. These are staging buffers
 * (e.g. shadow-probe-staging): promoteBufferUsage deliberately does NOT add
 * COPY_SRC to them (MAP_READ|COPY_SRC is an invalid WebGPU usage combo), so they
 * cannot be a copyBufferToBuffer source. The frame-header snapshot loop must skip
 * them — driving readbackBufferBytes on one throws "usage doesn't include
 * CopySrc". Their bytes are transient readback scratch, never seed payload, so
 * losing them is correct (mirrors promoteBufferUsage's own exclusion).
 */
function isMappableBuffer(usage: number): boolean {
  return (usage & (BUFFER_USAGE_MAP_READ | BUFFER_USAGE_MAP_WRITE)) !== 0;
}

export { TAPE_FORMAT_VERSION } from '../protocol/types';

// ============================================================================
// State machine
// ============================================================================

enum RecorderState {
  Idle = 'idle',
  Armed = 'armed',
  Snapshotting = 'snapshotting',
  Recording = 'recording',
  Finalizing = 'finalizing',
  Error = 'error',
}

// ============================================================================
// Hash utility for blob dedup
// ============================================================================

/** @internal */
let _nextHandleId = 0;

function allocHandleId(kind: string): HandleId {
  return `${kind}:${++_nextHandleId}`;
}

function fastHash(data: ArrayBuffer): string {
  const view = new Uint8Array(data);
  let hash = 5381;
  for (let i = 0; i < view.length; i++) {
    hash = ((hash << 5) + hash + (view[i] ?? 0)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function storeBlob(state: RecorderInternal, data: ArrayBuffer): string {
  const hash = fastHash(data);
  if (!state.blobPool.has(hash)) {
    state.blobPool.set(hash, data.slice(0) as ArrayBuffer);
  }
  return hash;
}

/**
 * Narrow a readbackBufferBytes failure to the snapshot stage.
 * readbackBufferBytes already tags `.detail.phase` with 'copy' | 'map'; carry
 * it through so the re-wrapped error preserves the failure point. Falls back to
 * 'copy' when the inner error lacks a snapshot detail.
 */
function snapshotStageOf(error: RhiDebugError): 'copy' | 'map' | 'store' {
  const d = error.detail;
  if ('phase' in d && d.phase !== undefined) return d.phase;
  return 'copy';
}

// ============================================================================
// Internal recorder state
// ============================================================================

type SnapshotProgress = {
  readonly startedAt: number;
  readonly stage: 'queue-drain' | 'resource-readback';
  readonly totalResources: number;
  readonly completedResources: number;
  readonly skippedResources: number;
  readonly currentHandleId: string | null;
  readonly currentKind: 'buffer' | 'texture' | null;
  readonly currentSizeBytes: number | null;
};

interface RecorderInternal {
  state: RecorderState;
  requestedFrames: number;
  recordedFrames: number;
  events: RhiCallEvent[];
  blobPool: Map<string, ArrayBuffer>;
  handleMap: WeakMap<object, HandleId>;
  textureViewHandleMap: WeakMap<TextureView, HandleId>;
  /**
   * @internal
   * Bootstrap create-event table. Populated by registerHandle when called
   * with a create event payload — records every create* (buffer, texture,
   * pipeline, bindGroup, shaderModule, …) from the moment wrap() is called,
   * independent of the recorder state machine (Idle / Armed / Recording).
   * Preserved across arm() cycles (SSOT for closure computation in getTape).
   */
  bootstrapCreates: Map<HandleId, RhiCallEvent>;
  /** Handles whose initialData event was emitted by the current capture. */
  snapshotSeededHandles: Set<HandleId>;
  /** Generation token invalidating async snapshot work after timeout/error. */
  snapshotGeneration: number;
  /** Last observable progress of the current/most recent resource snapshot. */
  snapshotProgress: SnapshotProgress | undefined;
  /**
   * @internal
   * Descriptor registry of currently-live resources. Written by createBuffer /
   * createTexture (after registerHandle) and cleared by destroyBuffer /
   * destroyTexture. Distinct from handleMap (WeakMap, handle object -> handleId
   * identity, one-way): descriptorTable carries the descriptor *content* (kind /
   * size / format / usage) AND the resource object keyed by handleId, so
   * snapshotResource can both determine a resource's shape and reach the object
   * for readback at frame-header time without re-scanning the event stream or
   * reverse-walking the WeakMap (which cannot be iterated). destroy* removes the
   * entry so the live-resource set never grows unbounded (AC-09). One registry,
   * one delete on destroy — shape and object share the same lifecycle (SSOT).
   */
  descriptorTable: Map<
    HandleId,
    {
      kind: 'buffer' | 'texture';
      size?: number | GPUExtent3DStrict;
      format?: GPUTextureFormat;
      sampleCount?: number;
      mipLevelCount?: number;
      usage: number;
      resource: object;
    }
  >;
  /** @internal */
  _skipRecord: boolean;
  frameIdx: number;
  bootstrap: boolean;
  recordedCaps: RhiCapsRecorded | undefined;
  onFrameEndUnsubscribe?: (() => void) | undefined;
  /** true when the current recording is valid. */
  valid: boolean;
  /**
   * @internal
   * Most recent live RhiDevice produced by `requestAdapter().requestDevice()`
   * via the recorder proxy chain. Captured so the adapter (I-2 fix) can
   * reach the same device for replay without forcing the host to expose
   * a separate channel.
   */
  capturedDevice: RhiDevice | undefined;
}

function snapshotTimeoutDetail(
  progress: SnapshotProgress | undefined,
  timeoutMs: number,
): import('../errors').CaptureTimeoutDetail {
  const current = progress ?? {
    startedAt: Date.now(),
    stage: 'queue-drain' as const,
    totalResources: 0,
    completedResources: 0,
    skippedResources: 0,
    currentHandleId: null,
    currentKind: null,
    currentSizeBytes: null,
  };
  return {
    stage: 'snapshot',
    cause: 'GPU readback did not complete before the bounded snapshot timeout',
    timeoutMs,
    progress: {
      snapshotStage: current.stage,
      totalResources: current.totalResources,
      completedResources: current.completedResources,
      skippedResources: current.skippedResources,
      currentHandleId: current.currentHandleId,
      currentKind: current.currentKind,
      currentSizeBytes: current.currentSizeBytes,
      elapsedMs: Math.max(0, Date.now() - current.startedAt),
    },
  };
}

/**
 * @internal
 * True while the recorder is in a state that appends normal RHI events to the
 * tape: Armed / Recording. Snapshotting is deliberately excluded: the async
 * frame-header seed phase must not fold live viewport frames into the capture.
 * This is the SSOT recording predicate —
 * `pushEvent` gates on it, and the proxy fast-path (writeBuffer / writeTexture /
 * createCommandEncoder) short-circuits when it is false so an idle recorder
 * (FORGEAX_ENGINE_RHI_DEBUG=1 but no capture in flight) pays no per-call
 * event-object allocation, no storeBlob hash+copy, and no proxy-encoder wrapping.
 *
 * Deliberately ignores `_skipRecord`: that flag suppresses recorder-internal
 * RHI calls (such as snapshot readback staging) during either capture phase.
 * `shouldRecord` folds it in for the normal pushEvent gate.
 */
function isRecordingActive(s: RecorderInternal): boolean {
  return s.state === RecorderState.Armed || s.state === RecorderState.Recording;
}

/**
 * A frame-header snapshot is not a normal render-recording phase, but it can
 * already have copied a live resource and still need that resource's create
 * event when it appends `initialData`. Keep bootstrap ownership through that
 * async window: per-frame feature resources may be released while readback is
 * awaiting GPU completion.
 */
function retainsCaptureBootstrap(s: RecorderInternal): boolean {
  return isRecordingActive(s) || s.state === RecorderState.Snapshotting;
}

/**
 * @internal
 * The exact pushEvent gate as a predicate: record iff not suppressed AND in an
 * active recording state. Proxy methods that do pre-pushEvent work (storeBlob,
 * event-object construction) check this first to skip that work when it would
 * be discarded — same-condition-as-pushEvent guarantees no behavioural drift
 * (a call that would record still does all its work).
 */
function shouldRecord(s: RecorderInternal): boolean {
  return !s._skipRecord && isRecordingActive(s);
}

function pushEvent(s: RecorderInternal, event: RhiCallEvent): void {
  if (!shouldRecord(s)) return;
  s.events.push(event);
}

/**
 * Append a frame-header seed without reopening the normal RHI event gate.
 * Snapshotting is not a render-recording state, but its async readback still
 * needs to emit initialData events for the resources that seed replay.
 */
function pushSnapshotEvent(s: RecorderInternal, event: RhiCallEvent): void {
  if (s._skipRecord || (!isRecordingActive(s) && s.state !== RecorderState.Snapshotting)) {
    return;
  }
  s.events.push(event);
}

function registerHandle(
  s: RecorderInternal,
  handle: object,
  kind: string,
  createEvent?: RhiCallEvent,
): HandleId {
  const hId = allocHandleId(kind);
  s.handleMap.set(handle, hId);
  if (createEvent !== undefined) {
    if ('handleId' in createEvent) Object.assign(createEvent, { handleId: hId });
    s.bootstrapCreates.set(hId, createEvent);
  }
  return hId;
}

function ensureTextureCreateEvent(
  s: RecorderInternal,
  texture: object,
  textureId: HandleId,
  viewFormat?: GPUTextureFormat,
): RhiDebugError | undefined {
  const existing = s.bootstrapCreates.get(textureId);
  if (existing !== undefined) {
    if (
      viewFormat !== undefined &&
      existing.kind === 'createTexture' &&
      existing.origin === 'swapchain'
    ) {
      addSwapchainViewFormat(existing, viewFormat);
    }
    return undefined;
  }

  const raw = texture as Record<string, unknown>;
  const width = raw.width as number | undefined;
  const height = raw.height as number | undefined;
  const depthOrArrayLayers = (raw.depthOrArrayLayers as number | undefined) ?? 1;
  const format = raw.format as string | undefined;
  const rawUsage = raw.usage as number | undefined;

  if (
    width === undefined ||
    height === undefined ||
    format === undefined ||
    rawUsage === undefined
  ) {
    return createRhiDebugError('tape-invalid', {
      stage: 'validate',
      cause: `swapchain texture '${textureId}' has unreadable dimensions (width=${width}, height=${height}, format=${format}, usage=${rawUsage})`,
      handleId: textureId,
      eventIndex: -1,
    });
  }

  const event: RhiCallEvent = {
    kind: 'createTexture',
    handleId: textureId,
    origin: 'swapchain',
    desc: {
      size: { width, height, depthOrArrayLayers },
      format: format as GPUTextureFormat,
      usage: (rawUsage | TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST) as GPUTextureUsageFlags,
      ...(viewFormat === undefined ? {} : { viewFormats: [viewFormat] }),
    },
  };
  s.bootstrapCreates.set(textureId, event);
  pushEvent(s, event);
  return undefined;
}

function addSwapchainViewFormat(
  texture: Extract<RhiCallEvent, { kind: 'createTexture' }>,
  viewFormat: GPUTextureFormat,
): void {
  if (texture.desc.format === viewFormat || texture.origin !== 'swapchain') return;
  const viewFormats = new Set(texture.desc.viewFormats ?? []);
  viewFormats.add(viewFormat);
  (texture as { desc: typeof texture.desc }).desc = {
    ...texture.desc,
    viewFormats: [...viewFormats],
  };
}

function reconcileSwapchainViewFormats(s: RecorderInternal): void {
  const events = [...s.events, ...s.bootstrapCreates.values()];
  for (const event of events) {
    if (event.kind !== 'createTextureView' || event.desc.format === undefined) continue;
    const source = s.bootstrapCreates.get(event.sourceHandleId);
    if (source?.kind === 'createTexture' && source.origin === 'swapchain') {
      addSwapchainViewFormat(source, event.desc.format);
    }
  }
}

function hasBootstrapDependency(s: RecorderInternal, handleId: HandleId): boolean {
  for (const event of s.bootstrapCreates.values()) {
    if (_getCreateEventReferencedHandleIds(event).includes(handleId)) return true;
  }
  return false;
}

function getHandleId(s: RecorderInternal, handle: object, kind: string): HandleId {
  const id = s.handleMap.get(handle);
  if (id !== undefined) return id;
  const newId = registerHandle(s, handle, kind);
  if (kind === 'texture') ensureTextureCreateEvent(s, handle, newId);
  return newId;
}

// ============================================================================
// Transitive closure — bootstrapCreates → self-contained tape prefix
// ============================================================================

/**
 * @internal
 * Collect all handleIds referenced by frame events in `s.events`.
 *
 * Scans events for ALL fields that reference resources — mirrors
 * the reference categories checked by findDanglingHandleId in
 * tape-format.ts to achieve producer/consumer convergence (D-2).
 *
 * Includes: buffer/texture/pipeline/bindGroup/sampler/textureView/
 * shaderModule handles (persistent), plus passHandleId and cmdHandleId
 * from pass/encoder events (per-frame transient). Transient handles
 * that are declared in-frame are excluded later by the inFrameHandleIds
 * filter in getTape().
 */

export interface DebugRhiInstance extends RhiInstance {
  arm(frames: number): Result<void, RhiDebugError>;
  onFrameEnd(): void;
  getTape(): Tape | RhiDebugError | undefined;
  getState(): string;
  getEvents(): readonly RhiCallEvent[];
  getBlobPool(): ReadonlyMap<string, ArrayBuffer>;
  /** Transition to error state (e.g. on device.lost). Tape data preserved but valid=false. */
  transitionToError(): void;
  /** Clear error state to idle, allowing re-arm. */
  disposeError(): void;
  /**
   * Snapshot a resource's GPU bytes into the tape as an initialData event.
   *
   * Reads the resource descriptor from the internal registry, copies the
   * resource's bytes via copyToBuffer/mapAsync, stores the bytes into the
   * blobPool (djb2 hash-dedup), and pushes an RhiCallEventInitialData into
   * the event stream. Returns Result with {handleId, dataHash} on success,
   * or capture-snapshot-failed on a readback/storeBlob failure.
   *
   * Async: the GPU readback chain (copyToBuffer -> submit ->
   * onSubmittedWorkDone -> mapAsync) is inherently asynchronous.
   */
  snapshotResource(
    handleId: HandleId,
  ): Promise<Result<{ handleId: HandleId; dataHash: string }, RhiDebugError>>;
  /**
   * Frame-header snapshot loop: awaits all submitted GPU work, then snapshots
   * every live resource in the descriptor registry (full-table dump, no
   * trimming). Advances the recorder Armed -> Snapshotting -> Recording on
   * success. Returns the first snapshot failure as a Result so the caller can
   * fail fast rather than record a partial seed set.
   */
  snapshotAllLiveResources(timeoutMs?: number): Promise<Result<void, RhiDebugError>>;
  /**
   * @internal
   * Append an event from a standalone wrapper (e.g. `wrapCreateShaderModule`)
   * through the same `_skipRecord` + state-machine guard that the proxy
   * methods use. This exists so external wrappers cannot bypass recursion
   * protection (I-12, round 1 implement-review). Not part of the AI-user
   * contract — `wrap*` helpers in this package are the only callers.
   */
  pushExternalEvent(event: RhiCallEvent): void;
  /**
   * @internal
   * Register a shader module object in the recorder's handleMap so
   * downstream pipeline events can look up its handleId via getHandleId.
   */
  registerShaderModule(handle: ShaderModule, handleId: HandleId): void;
  /**
   * @internal
   * Route a create event through registerHandle (alloc id + write bootstrapCreates)
   * and pushEvent in a single call. For standalone wrappers that cannot access
   * the internal registerHandle/pushEvent functions directly.
   * Returns the allocated HandleId so the caller can use it for downstream
   * registration (e.g. shaderModule → handleMap).
   */
  pushExternalCreateEvent(handle: object, kind: string, event: RhiCallEvent): HandleId;
  /**
   * @internal
   * Drop all device-bound recorder state after the host observes a real
   * device loss. A tape recorded against the lost device cannot seed a fresh
   * device, so the next capture must start from the rebuilt resource graph.
   */
  resetForDeviceLoss(): void;
  /** @internal Return whether the current capture is valid. */
  valid(): boolean;
  /**
   * @internal
   * Return the number of entries in bootstrapCreates. Test-only accessor
   * so unit tests can verify bootstrapCreates write/retain semantics
   * without going through getTape() closure computation (M2).
   */
  bootstrapCreatesSize(): number;
  /** @internal Return the create-event identities owned by the bootstrap registry. */
  bootstrapEvents(): readonly RhiCallEvent[];
  /**
   * @internal
   * Read-only view of the descriptor registry keyed by handleId. Test-only
   * accessor so unit tests can verify create* register / destroy* remove
   * semantics (AC-09) without reaching into the closed-over recorder state.
   */
  descriptorTable(): ReadonlyMap<
    HandleId,
    {
      kind: 'buffer' | 'texture';
      size?: number | GPUExtent3DStrict;
      format?: GPUTextureFormat;
      usage: number;
      resource: object;
    }
  >;
}

// ============================================================================
// Type for standalone createShaderModule function (from rhi-webgpu)
// ============================================================================

export type CreateShaderModuleFn = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>>;

export type { RecorderInternal, SnapshotProgress };
export {
  addSwapchainViewFormat,
  allocHandleId,
  ensureTextureCreateEvent,
  fastHash,
  getHandleId,
  hasBootstrapDependency,
  isDepthOrStencilFormat,
  isMappableBuffer,
  isRecordingActive,
  isSnapshottableColorTexture,
  promoteBufferUsage,
  pushEvent,
  pushSnapshotEvent,
  RecorderState,
  reconcileSwapchainViewFormats,
  registerHandle,
  retainsCaptureBootstrap,
  SNAPSHOT_TIMEOUT_MS,
  shouldRecord,
  snapshotStageOf,
  snapshotTimeoutDetail,
  storeBlob,
  TEXTURE_USAGE_BINDING,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_COPY_SRC,
};
