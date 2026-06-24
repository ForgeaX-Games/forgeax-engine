// @forgeax/engine-rhi-debug/src/recorder — RhiInstance proxy + state machine + blob pool.
//
// Core architecture:
// - wrap(rhiInstance) produces a DebugRhiInstance extending RhiInstance,
//   with all RHI method calls intercepted and recorded as RhiCallEvents.
// - handleMap: WeakMap<branded handle object, HandleId> for single-level mapping.
// - State machine: idle -> armed -> recording -> finalizing/error -> idle.
// - blob pool: fast-hash-based dedup of binary data.
// - perEventOverhead = 192 bytes (plan-strategy 5.3 locked; 256B is AC-06 upper bound).
// - _skipRecord flag prevents recursive recording of recorder-internal RHI calls.
//
// Related: requirements IS-1/IS-2/IS-8; plan-strategy D-1/D-4/D-6/D-7; AC-05-AC-10.

/// <reference types="@webgpu/types" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BindGroupDescriptor,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CommandBuffer,
  CommandEncoderDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  PipelineLayoutDescriptor,
  QuerySetDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  RequestAdapterOptions,
  RequestDeviceOptions,
  Result,
  RhiAdapter,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiInstance,
  RhiQueue,
  RhiRenderPassEncoder,
  SamplerDescriptor,
  ShaderModule,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import { err as makeErr, ok as makeOk } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { assembleReport, finalizeToMemory } from './recorder-core';
import type {
  HandleId,
  RhiBindResourceKind,
  RhiCallEvent,
  RhiCallEventWriteTexture,
  RhiCapsRecorded,
  Tape,
} from './types';

// Result factories `makeOk` / `makeErr` re-import the canonical
// `ok` / `err` from `@forgeax/engine-types` (architecture-principles #1
// SSOT — same shape, same factory, no inline duplicate). Aliased on
// import to avoid a free-form rename diff in this file's existing
// `makeOk(...)` / `makeErr(...)` call sites; semantics identical.

// ============================================================================
// Constants
// ============================================================================

export const PER_EVENT_OVERHEAD = 192 as const;

import { TAPE_FORMAT_VERSION } from './tape-format';

export { generateRunId } from './recorder-core';
export { TAPE_FORMAT_VERSION };

// ============================================================================
// State machine
// ============================================================================

enum RecorderState {
  Idle = 'idle',
  Armed = 'armed',
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

// ============================================================================
// Internal recorder state
// ============================================================================

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
  /** @internal */
  _skipRecord: boolean;
  frameIdx: number;
  bootstrap: boolean;
  recordedCaps: RhiCapsRecorded | undefined;
  onFrameEndUnsubscribe?: (() => void) | undefined;
  /** true when finalize() runs after a clean recording. false = capture error. */
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

function pushEvent(s: RecorderInternal, event: RhiCallEvent): void {
  if (s._skipRecord) return;
  if (s.state !== RecorderState.Armed && s.state !== RecorderState.Recording) return;
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
    // biome-ignore lint/suspicious/noExplicitAny: RhiCallEvent union has 39 members with varying field names; handleId stamp uses any to avoid per-member type narrowing
    (createEvent as any).handleId = hId;
    s.bootstrapCreates.set(hId, createEvent);
  }
  return hId;
}

function getHandleId(s: RecorderInternal, handle: object, kind: string): HandleId {
  const id = s.handleMap.get(handle);
  if (id !== undefined) return id;
  return registerHandle(s, handle, kind);
}

// ============================================================================
// Transitive closure — bootstrapCreates → self-contained tape prefix
// ============================================================================

/**
 * @internal
 * Collect all handleIds referenced by frame events in `s.events`.
 *
 * Scans events for fields that reference resources created by create* calls
 * (buffer/texture/pipeline/bindGroup/sampler/textureView/shaderModule).
 * Excludes pass handleIds, cmd handleIds, and inline 'layout:auto' strings.
 */
function _collectFrameReferencedHandleIds(events: readonly RhiCallEvent[]): Set<HandleId> {
  const refs = new Set<HandleId>();
  for (const e of events) {
    switch (e.kind) {
      case 'writeBuffer':
      case 'clearBuffer': {
        const we = e as { handleId: HandleId };
        refs.add(we.handleId);
        break;
      }
      case 'setVertexBuffer': {
        const we = e as { bufferHandleId: HandleId };
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setIndexBuffer': {
        const we = e as { bufferHandleId: HandleId };
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setPipeline': {
        const we = e as { pipelineHandleId: HandleId };
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setComputePipeline': {
        const we = e as { pipelineHandleId: HandleId };
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setBindGroup': {
        const we = e as { bindGroupHandleId: HandleId };
        refs.add(we.bindGroupHandleId);
        break;
      }
      case 'writeTexture': {
        const we = e as { destination: { textureHandleId: HandleId } };
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyBufferToBuffer': {
        const we = e as { sourceHandleId: HandleId; destinationHandleId: HandleId };
        refs.add(we.sourceHandleId);
        refs.add(we.destinationHandleId);
        break;
      }
      case 'copyBufferToTexture': {
        const we = e as {
          source: { bufferHandleId: HandleId };
          destination: { textureHandleId: HandleId };
        };
        refs.add(we.source.bufferHandleId);
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyTextureToBuffer': {
        const we = e as {
          source: { textureHandleId: HandleId };
          destination: { bufferHandleId: HandleId };
        };
        refs.add(we.source.textureHandleId);
        refs.add(we.destination.bufferHandleId);
        break;
      }
      case 'copyTextureToTexture': {
        const we = e as {
          source: { textureHandleId: HandleId };
          destination: { textureHandleId: HandleId };
        };
        refs.add(we.source.textureHandleId);
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'beginRenderPass': {
        const we = e as {
          colorAttachmentViewHandleIds: readonly (HandleId | undefined)[];
          depthStencilViewHandleId?: HandleId;
        };
        for (const vhId of we.colorAttachmentViewHandleIds) {
          if (vhId !== undefined) refs.add(vhId);
        }
        if (we.depthStencilViewHandleId !== undefined) refs.add(we.depthStencilViewHandleId);
        break;
      }
      // submit.cmdHandleIds refer to per-frame transient CommandEncoder
      // handles (allocated via allocHandleId, never written to bootstrapCreates).
      // Including them in the seed set would cause closure lookups to fail
      // with a spurious tape-handle-graph-broken on every valid capture.
      default:
        break;
    }
  }
  return refs;
}

/**
 * @internal
 * Return handleIds referenced by a create* event for transitive closure traversal.
 *
 * The edge set follows D-3 (plan-strategy 2):
 *   - createBindGroup → layoutHandleId + resourceHandleIds
 *   - createPipelineLayout → bglHandleIds
 *   - createRenderPipeline → layoutHandleId (if != 'layout:auto') + vertex/fragmentShaderModuleHandleId (R-1)
 *   - createComputePipeline → layoutHandleId (if != 'layout:auto') + computeShaderModuleHandleId (R-1)
 *   - createTextureView → sourceHandleId
 * Leaf resources (buffer / texture / sampler / BGL / shaderModule) return empty.
 */
function _getCreateEventReferencedHandleIds(event: RhiCallEvent): HandleId[] {
  switch (event.kind) {
    case 'createBindGroup': {
      const e = event as { layoutHandleId: HandleId; resourceHandleIds: readonly HandleId[] };
      return [e.layoutHandleId, ...e.resourceHandleIds];
    }
    case 'createPipelineLayout': {
      const e = event as { bglHandleIds: readonly HandleId[] };
      return [...e.bglHandleIds];
    }
    case 'createRenderPipeline': {
      const e = event as {
        layoutHandleId: HandleId;
        vertexShaderModuleHandleId?: HandleId;
        fragmentShaderModuleHandleId?: HandleId;
      };
      const refs: HandleId[] = [];
      if (e.layoutHandleId !== 'layout:auto') refs.push(e.layoutHandleId);
      if (e.vertexShaderModuleHandleId !== undefined) refs.push(e.vertexShaderModuleHandleId);
      if (e.fragmentShaderModuleHandleId !== undefined) refs.push(e.fragmentShaderModuleHandleId);
      return refs;
    }
    case 'createComputePipeline': {
      const e = event as { layoutHandleId: HandleId; computeShaderModuleHandleId?: HandleId };
      const refs: HandleId[] = [];
      if (e.layoutHandleId !== 'layout:auto') refs.push(e.layoutHandleId);
      if (e.computeShaderModuleHandleId !== undefined) refs.push(e.computeShaderModuleHandleId);
      return refs;
    }
    case 'createTextureView': {
      const e = event as { sourceHandleId: HandleId };
      return [e.sourceHandleId];
    }
    case 'createBuffer':
    case 'createTexture':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createShaderModule':
    case 'createCommandEncoder':
      return [];
    default:
      return [];
  }
}

/**
 * @internal
 * Compute the transitive closure of handleIds from bootstrapCreates.
 *
 * Starting from the given seed set, recursively walks all referenced handleIds
 * via _getCreateEventReferencedHandleIds. Returns the set of all handleIds
 * whose create events must be included in the tape prefix for self-containment.
 *
 * If any referenced handleId is not found in bootstrapCreates, returns
 * `null` for that id — the caller should produce a DebugError (w9).
 */
function _computeClosure(
  seedHandleIds: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
  inFrameHandleIds: Set<HandleId>,
): { closure: Set<HandleId>; missing: HandleId | null } {
  const closure = new Set(seedHandleIds);
  const queue = [...seedHandleIds];

  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const createEvent = bootstrapCreates.get(current);
    if (createEvent === undefined) {
      // The handle is not in bootstrapCreates. If it is declared in
      // s.events (e.g. swapchain textures from getCurrentTexture), treat it
      // as a leaf — no further expansion needed.
      if (inFrameHandleIds.has(current)) continue;
      return { closure, missing: current };
    }
    const edges = _getCreateEventReferencedHandleIds(createEvent);
    for (const target of edges) {
      if (!closure.has(target)) {
        closure.add(target);
        queue.push(target);
      }
    }
  }
  return { closure, missing: null };
}

/**
 * @internal
 * Topologically sort the closure set so that dependencies appear before dependents.
 *
 * Builds a dep-graph: if event A references handleId of event B, then B must
 * appear before A. Uses Kahn's algorithm.
 */
function _topoSortClosure(
  closure: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
): RhiCallEvent[] {
  const inDegree = new Map<HandleId, number>();
  const dependents = new Map<HandleId, HandleId[]>();

  for (const hId of closure) {
    inDegree.set(hId, 0);
    dependents.set(hId, []);
  }

  for (const hId of closure) {
    const event = bootstrapCreates.get(hId);
    if (event === undefined) continue;
    const edges = _getCreateEventReferencedHandleIds(event);
    for (const target of edges) {
      if (closure.has(target)) {
        // hId depends on target
        const current = dependents.get(target);
        if (current !== undefined) current.push(hId);
        inDegree.set(hId, (inDegree.get(hId) ?? 0) + 1);
      }
    }
  }

  const queue: HandleId[] = [];
  for (const [hId, deg] of inDegree) {
    if (deg === 0) queue.push(hId);
  }

  const sorted: RhiCallEvent[] = [];
  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const event = bootstrapCreates.get(current);
    if (event !== undefined) sorted.push(event);

    const deps = dependents.get(current);
    if (deps !== undefined) {
      for (const dep of deps) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }
  }

  return sorted;
}

// ============================================================================
// DebugRhiInstance — public interface
// ============================================================================

export interface DebugRhiInstance extends RhiInstance {
  arm(frames: number): Result<void, DebugError>;
  onFrameEnd(): void;
  finalize(): Result<{ runId: string; tapePath: string; reportPath: string }, DebugError>;
  getTape(): Tape | DebugError | undefined;
  getState(): string;
  getEvents(): readonly RhiCallEvent[];
  getBlobPool(): ReadonlyMap<string, ArrayBuffer>;
  /** Transition to error state (e.g. on device.lost). Tape data preserved but valid=false. */
  transitionToError(): void;
  /** Clear error state to idle, allowing re-arm. */
  disposeError(): void;
  /**
   * @internal
   * Append an event from a standalone wrapper (e.g. `wrapCreateShaderModule`)
   * through the same `_skipRecord` + state-machine guard that the proxy
   * methods use. This exists so external wrappers cannot bypass recursion
   * protection (I-12, round 1 implement-review). Not part of the AI-user
   * contract — `wrap*` helpers in this package are the only callers.
   */
  _pushExternalEvent(event: RhiCallEvent): void;
  /**
   * @internal
   * Register a shader module object in the recorder's handleMap so
   * downstream pipeline events can look up its handleId via getHandleId.
   */
  _registerShaderModule(handle: ShaderModule, handleId: HandleId): void;
  /**
   * @internal
   * Route a create event through registerHandle (alloc id + write bootstrapCreates)
   * and pushEvent in a single call. For standalone wrappers that cannot access
   * the internal registerHandle/pushEvent functions directly.
   * Returns the allocated HandleId so the caller can use it for downstream
   * registration (e.g. shaderModule → handleMap).
   */
  _pushExternalCreateEvent(handle: object, kind: string, event: RhiCallEvent): HandleId;
  /**
   * @internal
   * Return the most recent `RhiDevice` produced through the recorder's
   * proxied `requestAdapter().requestDevice()` chain. `undefined` when
   * the host has not yet driven a device acquisition through the proxy.
   * Consumed by `createDebugRhiAdapter` (I-2 fix) to reach the live
   * replay target device.
   */
  _getCapturedDevice(): RhiDevice | undefined;
  /**
   * @internal
   * Return the recorder's `valid` flag. Consumed by `finalizeToMemory`
   * in recorder-core to embed `valid` in the serialized report without
   * duplicating state-machine knowledge.
   */
  _getValid(): boolean;
  /**
   * @internal
   * Return the number of entries in bootstrapCreates. Test-only accessor
   * so unit tests can verify bootstrapCreates write/retain semantics
   * without going through getTape() closure computation (M2).
   */
  _getBootstrapCreatesSize(): number;
}

// ============================================================================
// Type for standalone createShaderModule function (from rhi-webgpu)
// ============================================================================

export type CreateShaderModuleFn = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>>;

// ============================================================================
// wrap(rhiInstance) — main entry point
// ============================================================================

export function wrap(instance: RhiInstance): DebugRhiInstance {
  const s: RecorderInternal = {
    state: RecorderState.Idle,
    requestedFrames: 0,
    recordedFrames: 0,
    events: [],
    blobPool: new Map(),
    handleMap: new WeakMap(),
    textureViewHandleMap: new WeakMap(),
    bootstrapCreates: new Map(),
    _skipRecord: false,
    frameIdx: 0,
    bootstrap: true,
    recordedCaps: undefined,
    valid: true,
    capturedDevice: undefined,
  };

  // --------------------------------------------------
  // debug surface methods
  // --------------------------------------------------

  function arm(frames: number): Result<void, DebugError> {
    if (
      s.state === RecorderState.Armed ||
      s.state === RecorderState.Recording ||
      s.state === RecorderState.Finalizing
    ) {
      return makeErr(
        new DebugError({
          code: 'recorder-already-armed',
          expected: 'arm() called while recorder not idle',
          hint: 'wait for current capture to finish or call replayDispose()',
        }),
      ) as unknown as Result<void, DebugError>;
    }
    if (s.state === RecorderState.Error) {
      return makeErr(
        new DebugError({
          code: 'recorder-not-attached',
          expected: 'arm() called while recorder is idle (error state requires disposeError())',
          hint: 'recorder is in error state from a prior capture failure; call disposeError() to clear before re-arming',
        }),
      ) as unknown as Result<void, DebugError>;
    }

    s.state = RecorderState.Armed;
    s.requestedFrames = frames;
    s.recordedFrames = 0;
    s.events = [];
    s.blobPool = new Map();
    s.frameIdx = 0;
    s.bootstrap = true;
    s.valid = true;
    return makeOk(undefined) as unknown as Result<void, DebugError>;
  }

  function onFrameEnd(): void {
    if (s.state === RecorderState.Idle) {
      s.frameIdx++;
      s.bootstrap = false;
      return;
    }

    if (s.state === RecorderState.Armed) {
      s.state = RecorderState.Recording;
      s.bootstrap = false;
    }

    if (s.state === RecorderState.Recording) {
      // Emit frameMark at end of this frame
      s.events.push({ kind: 'frameMark', frameIdx: s.frameIdx });
      s.recordedFrames++;
      s.frameIdx++;

      if (s.recordedFrames >= s.requestedFrames) {
        s.state = RecorderState.Finalizing;
        if (s.onFrameEndUnsubscribe) {
          s.onFrameEndUnsubscribe();
          s.onFrameEndUnsubscribe = undefined;
        }
        s.state = RecorderState.Idle;
      }
      return;
    }

    // finalizing or error: no-op
    s.frameIdx++;
  }

  function getTape(): Tape | DebugError | undefined {
    if (s.events.length === 0) return undefined;

    // Pre-scan s.events for create* declarations: handleIds whose
    // create event is already carried by the frame events (transient
    // per-frame resources like swapchain textures, command encoders).
    // These handles do NOT need bootstrap prefixing -- they were born
    // during the recorded frame and their create event is in s.events.
    const inFrameHandleIds = new Set<HandleId>();
    for (const e of s.events) {
      if (
        e.kind.startsWith('create') &&
        'handleId' in e &&
        typeof (e as { handleId: unknown }).handleId === 'string'
      ) {
        inFrameHandleIds.add((e as { handleId: HandleId }).handleId);
      }
      // Also collect backward-referenced handleIds from create events in
      // s.events. For example, createTextureView.sourceHandleId points to
      // swapchain textures (from getCurrentTexture) that never get their own
      // createTexture event. These handleIds exist only as references within
      // frame events and must not trigger bootstrap lookup.
      const backwardRefs = _getCreateEventReferencedHandleIds(e);
      for (const ref of backwardRefs) {
        inFrameHandleIds.add(ref);
      }
    }

    // Collect frame-referenced handleIds from per-frame events.
    const allFrameHandleIds = _collectFrameReferencedHandleIds(s.events);

    // Exclude handles whose create event is already in s.events:
    // only compute bootstrap closure for handles that need prefixing.
    const prefixSeedIds = new Set<HandleId>();
    for (const hId of allFrameHandleIds) {
      if (!inFrameHandleIds.has(hId)) {
        prefixSeedIds.add(hId);
      }
    }

    // Transitive closure from bootstrapCreates
    const { closure, missing } = _computeClosure(
      prefixSeedIds,
      s.bootstrapCreates,
      inFrameHandleIds,
    );

    if (missing !== null) {
      // Missing create — return error (hint refined in w9)
      return new DebugError({
        code: 'tape-handle-graph-broken',
        expected: 'all referenced handleIds must have create events in bootstrapCreates',
        hint: `handleId '${missing}' has no create event in bootstrap table; the resource may have been created before wrap() was called — re-capture with recorder wrap() before all resource creation`,
        detail: {
          danglingHandleId: missing,
          referencingEventIndex: -1,
        },
      });
    }

    // Topological sort: dependencies (leaf resources) before dependents
    const prefixEvents: RhiCallEvent[] = _topoSortClosure(closure, s.bootstrapCreates);

    // dedup: only prefix create events not already in s.events.
    const dedupedPrefx = prefixEvents.filter((e) => {
      if ('handleId' in e && typeof (e as { handleId: unknown }).handleId === 'string') {
        return !inFrameHandleIds.has((e as { handleId: HandleId }).handleId);
      }
      return true;
    });

    return {
      formatVersion: TAPE_FORMAT_VERSION,
      rhiCapsRecorded: s.recordedCaps ?? {
        canvasFormat: 'bgra8unorm' as GPUTextureFormat,
        rgba16floatRenderable: false,
        float32Filterable: false,
        textureCompression: false,
        storageBuffer: false,
        timestampQuery: false,
      },
      events: [...dedupedPrefx, ...s.events],
      blobPool: s.blobPool,
    };
  }

  function getState(): string {
    return s.state;
  }
  function getEvents(): readonly RhiCallEvent[] {
    return s.events;
  }
  function getBlobPool(): ReadonlyMap<string, ArrayBuffer> {
    return s.blobPool;
  }

  function finalize(): Result<{ runId: string; tapePath: string; reportPath: string }, DebugError> {
    const fmResult = finalizeToMemory({ getTape, _getValid: () => s.valid });
    if (!fmResult.ok) {
      return fmResult as unknown as Result<
        { runId: string; tapePath: string; reportPath: string },
        DebugError
      >;
    }

    const { runId, json, blob, passOffsets, valid } = fmResult.value;
    const outDir = path.join('.forgeax-debug', runId);
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      return makeErr(
        new DebugError({
          code: 'png-encode-failed',
          expected: 'writable .forgeax-debug directory',
          hint: `failed to create output directory '${outDir}'; check filesystem permissions`,
        }),
      ) as unknown as Result<{ runId: string; tapePath: string; reportPath: string }, DebugError>;
    }

    const tapePath = path.join(outDir, 'frame-0.tape.bin');

    try {
      fs.writeFileSync(tapePath, blob);
    } catch {
      return makeErr(
        new DebugError({
          code: 'png-encode-failed',
          expected: 'writable tape binary file',
          hint: `failed to write tape binary to '${tapePath}'`,
        }),
      ) as unknown as Result<{ runId: string; tapePath: string; reportPath: string }, DebugError>;
    }

    const report = assembleReport({ json, passOffsets, valid });
    const reportPath = path.join(outDir, 'frame-0.report.json');

    try {
      fs.writeFileSync(reportPath, JSON.stringify(report));
    } catch {
      return makeErr(
        new DebugError({
          code: 'png-encode-failed',
          expected: 'writable report file',
          hint: `failed to write report file to '${reportPath}'`,
        }),
      ) as unknown as Result<{ runId: string; tapePath: string; reportPath: string }, DebugError>;
    }

    return makeOk({ runId, tapePath, reportPath }) as Result<
      { runId: string; tapePath: string; reportPath: string },
      DebugError
    >;
  }

  function transitionToError(): void {
    if (s.state === RecorderState.Recording || s.state === RecorderState.Armed) {
      s.state = RecorderState.Error;
      s.valid = false;
      if (s.onFrameEndUnsubscribe) {
        s.onFrameEndUnsubscribe();
        s.onFrameEndUnsubscribe = undefined;
      }
    }
  }

  function disposeError(): void {
    if (s.state === RecorderState.Error) {
      s.state = RecorderState.Idle;
      s.events = [];
      s.blobPool = new Map();
      s.valid = true;
    }
  }

  // --------------------------------------------------
  // proxy construction
  // --------------------------------------------------

  function proxyQueue(realQueue: RhiQueue): RhiQueue {
    return {
      writeBuffer(
        buffer: Buffer,
        bufferOffset: number,
        data: ArrayBufferView | ArrayBuffer,
        dataOffset?: number,
        size?: number,
      ) {
        const hId = getHandleId(s, buffer as unknown as object, 'buffer');
        const raw = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer);
        const sz = size ?? raw.byteLength - (dataOffset ?? 0);
        const slice = raw.slice(dataOffset ?? 0, (dataOffset ?? 0) + sz);
        const dataHash = storeBlob(s, slice.buffer as ArrayBuffer);

        pushEvent(s, {
          kind: 'writeBuffer',
          handleId: hId,
          bufferOffset,
          dataHash,
          size: sz,
        });
        return realQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
      },

      writeTexture(destination, data, dataLayout, copySize) {
        const hId = getHandleId(s, destination.texture as unknown as object, 'texture');
        const raw = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer);
        const dataHash = storeBlob(s, raw.buffer as ArrayBuffer);

        pushEvent(s, {
          kind: 'writeTexture',
          destination: {
            textureHandleId: hId,
            mipLevel: destination.mipLevel,
            origin: destination.origin,
            aspect: destination.aspect,
          },
          dataHash,
          dataLayout: {
            offset: dataLayout.offset,
            bytesPerRow: dataLayout.bytesPerRow,
            rowsPerImage: dataLayout.rowsPerImage,
          },
          size: copySize,
        } as RhiCallEventWriteTexture);
        return realQueue.writeTexture(destination, data, dataLayout, copySize);
      },

      copyExternalImageToTexture(source, destination, copySize) {
        const hId = getHandleId(s, destination.texture as unknown as object, 'texture');
        pushEvent(s, {
          kind: 'copyExternalImageToTexture',
          source: { origin: source.origin, flipY: source.flipY },
          destination: {
            textureHandleId: hId,
            mipLevel: destination.mipLevel,
            origin: destination.origin,
            aspect: destination.aspect,
            colorSpace: destination.colorSpace,
            premultipliedAlpha: destination.premultipliedAlpha,
          },
          copySize,
        });
        return realQueue.copyExternalImageToTexture(source, destination, copySize);
      },

      submit(commandBuffers: readonly CommandBuffer[]) {
        const cmdHandleIds = commandBuffers.map((cb) =>
          getHandleId(s, cb as unknown as object, 'commandBuffer'),
        );
        pushEvent(s, { kind: 'submit', cmdHandleIds });
        return realQueue.submit(commandBuffers);
      },

      onSubmittedWorkDone() {
        return realQueue.onSubmittedWorkDone();
      },
    };
  }

  function proxyRenderPass(
    realPass: RhiRenderPassEncoder,
    passHId: HandleId,
  ): RhiRenderPassEncoder {
    return {
      setPipeline(pipeline: RenderPipeline) {
        const pid = getHandleId(s, pipeline as unknown as object, 'renderPipeline');
        pushEvent(s, { kind: 'setPipeline', passHandleId: passHId, pipelineHandleId: pid });
        realPass.setPipeline(pipeline);
      },
      setVertexBuffer(slot, buffer, offset, size) {
        const bid = getHandleId(s, buffer as unknown as object, 'buffer');
        pushEvent(s, {
          kind: 'setVertexBuffer',
          passHandleId: passHId,
          slot,
          bufferHandleId: bid,
          offset,
          size,
        });
        realPass.setVertexBuffer(slot, buffer, offset, size);
      },
      setIndexBuffer(buffer, format, offset, size) {
        const bid = getHandleId(s, buffer as unknown as object, 'buffer');
        pushEvent(s, {
          kind: 'setIndexBuffer',
          passHandleId: passHId,
          bufferHandleId: bid,
          format,
          offset,
          size,
        });
        realPass.setIndexBuffer(buffer, format, offset, size);
      },
      setBindGroup(index, bindGroup, ...rest: unknown[]) {
        const bgid = getHandleId(s, bindGroup as unknown as object, 'bindGroup');
        let dynOffsets: readonly number[] | undefined;
        if (rest[0] instanceof Uint32Array) {
          dynOffsets = Array.from(rest[0] as Uint32Array);
          (realPass.setBindGroup as unknown as (...args: unknown[]) => void)(
            index,
            bindGroup,
            ...rest,
          );
        } else {
          dynOffsets = rest[0] as readonly number[] | undefined;
          realPass.setBindGroup(index, bindGroup, dynOffsets);
        }
        pushEvent(s, {
          kind: 'setBindGroup',
          passHandleId: passHId,
          index,
          bindGroupHandleId: bgid,
          dynamicOffsets: dynOffsets,
        });
      },
      draw(vertexCount, instanceCount, firstVertex, firstInstance) {
        pushEvent(s, {
          kind: 'draw',
          passHandleId: passHId,
          vertexCount,
          instanceCount: instanceCount ?? 1,
          firstVertex: firstVertex ?? 0,
          firstInstance: firstInstance ?? 0,
        });
        realPass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
      },
      drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
        pushEvent(s, {
          kind: 'drawIndexed',
          passHandleId: passHId,
          indexCount,
          instanceCount: instanceCount ?? 1,
          firstIndex: firstIndex ?? 0,
          baseVertex: baseVertex ?? 0,
          firstInstance: firstInstance ?? 0,
        });
        realPass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
      },

      // Pass-through methods (not in v1 event set, but must not break the proxy)
      setViewport(x, y, w, h, minDepth, maxDepth) {
        realPass.setViewport(x, y, w, h, minDepth, maxDepth);
      },
      setScissorRect(x, y, w, h) {
        realPass.setScissorRect(x, y, w, h);
      },
      setBlendConstant(color) {
        realPass.setBlendConstant(color);
      },
      setStencilReference(reference) {
        realPass.setStencilReference(reference);
      },
      drawIndirect(indirectBuffer, indirectOffset) {
        realPass.drawIndirect(indirectBuffer, indirectOffset);
      },
      drawIndexedIndirect(indirectBuffer, indirectOffset) {
        realPass.drawIndexedIndirect(indirectBuffer, indirectOffset);
      },
      pushDebugGroup(groupLabel) {
        realPass.pushDebugGroup(groupLabel);
      },
      popDebugGroup() {
        realPass.popDebugGroup();
      },
      insertDebugMarker(markerLabel) {
        realPass.insertDebugMarker(markerLabel);
      },
      executeBundles(bundles) {
        return realPass.executeBundles(bundles);
      },
      beginOcclusionQuery(queryIndex) {
        return realPass.beginOcclusionQuery(queryIndex);
      },
      endOcclusionQuery() {
        return realPass.endOcclusionQuery();
      },
      end() {
        pushEvent(s, { kind: 'endRenderPass', passHandleId: passHId });
        realPass.end();
      },
    };
  }

  function proxyComputePass(
    realPass: RhiComputePassEncoder,
    passHId: HandleId,
  ): RhiComputePassEncoder {
    return {
      setPipeline(pipeline: ComputePipeline) {
        const pid = getHandleId(s, pipeline as unknown as object, 'computePipeline');
        pushEvent(s, { kind: 'setComputePipeline', passHandleId: passHId, pipelineHandleId: pid });
        realPass.setPipeline(pipeline);
      },
      setBindGroup(index, bindGroup, dynamicOffsets) {
        const bgid = getHandleId(s, bindGroup as unknown as object, 'bindGroup');
        pushEvent(s, {
          kind: 'setBindGroup',
          passHandleId: passHId,
          index,
          bindGroupHandleId: bgid,
          dynamicOffsets,
        });
        realPass.setBindGroup(index, bindGroup, dynamicOffsets);
      },
      dispatchWorkgroups(x, y, z) {
        pushEvent(s, {
          kind: 'dispatchWorkgroups',
          passHandleId: passHId,
          x,
          y: y ?? 1,
          z: z ?? 1,
        });
        realPass.dispatchWorkgroups(x, y, z);
      },
      end() {
        pushEvent(s, { kind: 'endComputePass', passHandleId: passHId });
        realPass.end();
      },
    };
  }

  function proxyCmdEncoder(realEnc: RhiCommandEncoder, cmdHId: HandleId): RhiCommandEncoder {
    return {
      beginRenderPass(desc: GPURenderPassDescriptor) {
        const passHId = allocHandleId('renderPass');
        // I-2 fix-up (round 1, dawn smoke): walk colorAttachments +
        // depthStencilAttachment to extract the textureView handleIds
        // recorded under createTextureView. Without this the replayer
        // would dereference the original GPUTextureView brand directly,
        // which fails on a fresh device (cross-device GPU object reuse).
        const colorAttachmentViewHandleIds: (HandleId | undefined)[] = [];
        for (const att of desc.colorAttachments) {
          if (att === null || att === undefined) {
            colorAttachmentViewHandleIds.push(undefined);
          } else {
            const view = (att as GPURenderPassColorAttachment).view;
            const id =
              view !== undefined && view !== null
                ? s.handleMap.get(view as unknown as object)
                : undefined;
            colorAttachmentViewHandleIds.push(id);
          }
        }
        let depthStencilViewHandleId: HandleId | undefined;
        if (desc.depthStencilAttachment !== undefined) {
          const dsView = desc.depthStencilAttachment.view;
          if (dsView !== undefined && dsView !== null) {
            depthStencilViewHandleId = s.handleMap.get(dsView as unknown as object);
          }
        }
        pushEvent(s, {
          kind: 'beginRenderPass',
          cmdHandleId: cmdHId,
          passHandleId: passHId,
          desc: desc as Omit<GPURenderPassDescriptor, 'label'>,
          colorAttachmentViewHandleIds,
          depthStencilViewHandleId,
        });
        const realPass = realEnc.beginRenderPass(desc);
        return proxyRenderPass(realPass, passHId);
      },
      beginComputePass(desc?: GPUComputePassDescriptor | undefined) {
        const passHId = allocHandleId('computePass');
        pushEvent(s, {
          kind: 'beginComputePass',
          cmdHandleId: cmdHId,
          passHandleId: passHId,
          desc: desc as Partial<GPUComputePassDescriptor> | undefined,
        });
        const realPass = realEnc.beginComputePass(desc);
        return proxyComputePass(realPass, passHId);
      },
      // Passthrough copy/clear methods (event recording added where types permit)
      copyBufferToBuffer(...args: unknown[]) {
        // Overloaded: 3-arg or 5-arg
        if (typeof args[1] === 'number') {
          (realEnc.copyBufferToBuffer as unknown as (...args: unknown[]) => void)(...args);
        } else {
          realEnc.copyBufferToBuffer(
            args[0] as Buffer,
            args[1] as Buffer,
            args[2] as number | undefined,
          );
        }
      },
      copyBufferToTexture(source, destination, copySize) {
        realEnc.copyBufferToTexture(source, destination, copySize);
      },
      copyTextureToBuffer(source, destination, copySize) {
        realEnc.copyTextureToBuffer(source, destination, copySize);
      },
      copyTextureToTexture(source, destination, copySize) {
        realEnc.copyTextureToTexture(source, destination, copySize);
      },
      clearBuffer(buffer, offset, size) {
        realEnc.clearBuffer(buffer, offset, size);
      },
      resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
        return realEnc.resolveQuerySet(
          querySet,
          firstQuery,
          queryCount,
          destination,
          destinationOffset,
        );
      },
      writeTimestamp(querySet, queryIndex) {
        realEnc.writeTimestamp(querySet, queryIndex);
      },
      pushDebugGroup(groupLabel) {
        realEnc.pushDebugGroup(groupLabel);
      },
      popDebugGroup() {
        realEnc.popDebugGroup();
      },
      insertDebugMarker(markerLabel) {
        realEnc.insertDebugMarker(markerLabel);
      },
      finish() {
        pushEvent(s, { kind: 'finish', cmdHandleId: cmdHId });
        const res = realEnc.finish();
        // I-2 fix-up (round 1, dawn smoke handle-graph integrity):
        // alias the resulting CommandBuffer object to the encoder's
        // cmdHandleId so subsequent queue.submit() handle lookups resolve
        // to the SAME id that the createCommandEncoder/finish event pair
        // declared. Without this, submit would register a fresh handleId
        // for the CommandBuffer object and the tape's handle graph
        // integrity check would reject the tape on deserialize.
        if (res.ok) {
          s.handleMap.set(res.value as unknown as object, cmdHId);
        }
        return res;
      },
    };
  }

  function proxyDevice(realDevice: RhiDevice): RhiDevice {
    const proxiedQueue = proxyQueue(realDevice.queue);

    // Expose the real RhiDevice for standalone createShaderModule calls.
    // engine-rhi-webgpu's createShaderModule uses RAW_DEVICE_MAP (WeakMap)
    // to reverse-lookup the GPUDevice. The proxy is a different JS object
    // from the RhiDevice that makeRhiDevice registered, so WeakMap.get(proxy)
    // returns undefined and createShaderModule returns shader-compile-failed.
    // The _realDevice property lets callers pass the real RhiDevice directly.
    type RhiDeviceWithReal = RhiDevice & { _realDevice: RhiDevice };

    const d: RhiDeviceWithReal = {
      _realDevice: realDevice,

      get caps() {
        return realDevice.caps;
      },
      get features() {
        return realDevice.features;
      },
      get limits() {
        return realDevice.limits;
      },
      get queue() {
        return proxiedQueue;
      },
      get lost() {
        return realDevice.lost;
      },

      createBuffer(desc: BufferDescriptor) {
        const res = realDevice.createBuffer(desc);
        if (!res.ok) return res;
        const event: RhiCallEvent = {
          kind: 'createBuffer',
          handleId: '' as HandleId,
          desc: {
            size: desc.size ?? 0,
            usage: desc.usage ?? 0,
            mappedAtCreation: desc.mappedAtCreation,
          },
        };
        registerHandle(s, res.value as unknown as object, 'buffer', event);
        pushEvent(s, event);
        return res;
      },

      createTexture(desc: TextureDescriptor) {
        const res = realDevice.createTexture(desc);
        if (!res.ok) return res;
        const event: RhiCallEvent = {
          kind: 'createTexture',
          handleId: '' as HandleId,
          desc: {
            size: desc.size ?? { width: 1, height: 1 },
            mipLevelCount: desc.mipLevelCount,
            sampleCount: desc.sampleCount,
            dimension: desc.dimension,
            format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
            usage: desc.usage ?? 0,
            viewFormats: desc.viewFormats,
            textureBindingViewDimension: desc.textureBindingViewDimension,
          },
        };
        registerHandle(s, res.value as unknown as object, 'texture', event);
        pushEvent(s, event);
        return res;
      },

      createTextureView(texture: Texture, desc: TextureViewDescriptor) {
        const res = realDevice.createTextureView(texture, desc);
        if (!res.ok) return res;
        const srcId = getHandleId(s, texture as unknown as object, 'texture');
        const viewId = registerHandle(s, res.value as unknown as object, 'textureView');
        s.textureViewHandleMap.set(res.value, viewId);

        // Emit a faithful createTexture if the source texture is a
        // swapchain texture that has no createTexture event yet.
        // getCurrentTexture() returns the raw GPUTexture whose runtime
        // properties (width, height, format, usage) are readable —
        // read them to construct a faithful createTexture event instead
        // of a synthetic 1x1 stand-in (D-1, C-3).
        if (!s.bootstrapCreates.has(srcId)) {
          const raw = texture as unknown as Record<string, unknown>;
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
            return makeErr(
              new DebugError({
                code: 'tape-handle-graph-broken',
                expected:
                  'swapchain GPUTexture runtime properties readable (width/height/format/usage)',
                hint: `swapchain texture '${srcId}' has unreadable dimensions (width=${width}, height=${height}, format=${format}, usage=${rawUsage}); the backend may not expose runtime texture properties — re-capture with a device that does`,
                detail: {
                  danglingHandleId: srcId,
                  referencingEventIndex: -1,
                },
              }),
            ) as unknown as Result<TextureView, import('@forgeax/engine-rhi').RhiError>;
          }

          const texEvent: RhiCallEvent = {
            kind: 'createTexture',
            handleId: srcId,
            desc: {
              size: { width, height, depthOrArrayLayers },
              format: format as GPUTextureFormat,
              usage: (rawUsage | 0x01) as GPUTextureUsageFlags, // D-4: COPY_SRC for replay readbackRt
            },
          };
          s.bootstrapCreates.set(srcId, texEvent);
          pushEvent(s, texEvent);
        }

        const event: RhiCallEvent = {
          kind: 'createTextureView',
          sourceHandleId: srcId,
          resultHandleId: viewId,
          desc: {
            format: desc.format,
            dimension: desc.dimension,
            usage: desc.usage,
            aspect: desc.aspect,
            baseMipLevel: desc.baseMipLevel,
            mipLevelCount: desc.mipLevelCount,
            baseArrayLayer: desc.baseArrayLayer,
            arrayLayerCount: desc.arrayLayerCount,
          },
        };
        s.bootstrapCreates.set(viewId, event);
        pushEvent(s, event);
        return res;
      },

      createSampler(desc?: SamplerDescriptor | undefined) {
        const res = realDevice.createSampler(desc);
        if (!res.ok) return res;
        const event: RhiCallEvent = {
          kind: 'createSampler',
          handleId: '' as HandleId,
          desc: desc as Partial<GPUSamplerDescriptor> | undefined,
        };
        registerHandle(s, res.value as unknown as object, 'sampler', event);
        pushEvent(s, event);
        return res;
      },

      createBindGroupLayout(desc: BindGroupLayoutDescriptor) {
        const res = realDevice.createBindGroupLayout(desc);
        if (!res.ok) return res;
        const event: RhiCallEvent = {
          kind: 'createBindGroupLayout',
          handleId: '' as HandleId,
          desc: { label: desc.label, entries: desc.entries ?? [] },
        };
        registerHandle(s, res.value as unknown as object, 'bindGroupLayout', event);
        pushEvent(s, event);
        return res;
      },

      createBindGroup(desc: BindGroupDescriptor) {
        const res = realDevice.createBindGroup(desc);
        if (!res.ok) return res;
        const layoutId = getHandleId(s, desc.layout as unknown as object, 'bindGroupLayout');
        const entries = Array.from(desc.entries);
        const resourceKinds: RhiBindResourceKind[] = entries.map((e) => e.resource.kind);
        const resourceHandleIds: HandleId[] = entries.map((e) => {
          const r = e.resource;
          switch (r.kind) {
            case 'sampler':
              return getHandleId(s, r.value as unknown as object, 'sampler');
            case 'buffer':
              return getHandleId(s, r.value.buffer as unknown as object, 'buffer');
            case 'textureView':
              return getHandleId(s, r.value as unknown as object, 'textureView');
            case 'externalTexture':
              return 'externalTexture:unknown';
          }
          return 'externalTexture:unknown' as HandleId;
        });
        const event: RhiCallEvent = {
          kind: 'createBindGroup',
          handleId: '' as HandleId,
          layoutHandleId: layoutId,
          entries: entries.map((e, idx) => ({
            binding: e.binding,
            resourceKind: resourceKinds[idx] as RhiBindResourceKind,
          })),
          resourceHandleIds,
        };
        registerHandle(s, res.value as unknown as object, 'bindGroup', event);
        pushEvent(s, event);
        return res;
      },

      createPipelineLayout(desc: PipelineLayoutDescriptor) {
        const res = realDevice.createPipelineLayout(desc);
        if (!res.ok) return res;
        const bglIds = Array.from(desc.bindGroupLayouts).map((bgl) =>
          getHandleId(s, bgl as unknown as object, 'bindGroupLayout'),
        );
        const event: RhiCallEvent = {
          kind: 'createPipelineLayout',
          handleId: '' as HandleId,
          bglHandleIds: bglIds,
        };
        registerHandle(s, res.value as unknown as object, 'pipelineLayout', event);
        pushEvent(s, event);
        return res;
      },

      createRenderPipeline(desc: RenderPipelineDescriptor) {
        const res = realDevice.createRenderPipeline(desc);
        if (!res.ok) return res;
        let layoutId: HandleId;
        if (typeof desc.layout === 'string') {
          layoutId = 'layout:auto';
        } else {
          layoutId = getHandleId(s, desc.layout as unknown as object, 'pipelineLayout');
        }
        let vertexShaderModuleHandleId: HandleId | undefined;
        if (desc.vertex !== undefined) {
          vertexShaderModuleHandleId = getHandleId(
            s,
            desc.vertex.module as unknown as object,
            'shaderModule',
          );
        }
        let fragmentShaderModuleHandleId: HandleId | undefined;
        if (desc.fragment !== undefined) {
          fragmentShaderModuleHandleId = getHandleId(
            s,
            desc.fragment.module as unknown as object,
            'shaderModule',
          );
        }
        const event: RhiCallEvent = {
          kind: 'createRenderPipeline',
          handleId: '' as HandleId,
          desc: {
            vertex: desc.vertex,
            primitive: desc.primitive,
            depthStencil: desc.depthStencil,
            multisample: desc.multisample,
            fragment: desc.fragment,
          },
          layoutHandleId: layoutId,
          vertexShaderModuleHandleId,
          fragmentShaderModuleHandleId,
        };
        registerHandle(s, res.value as unknown as object, 'renderPipeline', event);
        pushEvent(s, event);
        return res;
      },

      createComputePipeline(desc: ComputePipelineDescriptor) {
        const res = realDevice.createComputePipeline(desc);
        if (!res.ok) return res;
        let layoutId: HandleId;
        if (typeof desc.layout === 'string') {
          layoutId = 'layout:auto';
        } else {
          layoutId = getHandleId(s, desc.layout as unknown as object, 'pipelineLayout');
        }
        const computeShaderModuleHandleId = getHandleId(
          s,
          desc.compute.module as unknown as object,
          'shaderModule',
        );
        const event: RhiCallEvent = {
          kind: 'createComputePipeline',
          handleId: '' as HandleId,
          desc: { compute: desc.compute as unknown as GPUProgrammableStage },
          layoutHandleId: layoutId,
          computeShaderModuleHandleId,
        };
        registerHandle(s, res.value as unknown as object, 'computePipeline', event);
        pushEvent(s, event);
        return res;
      },

      createQuerySet(desc: QuerySetDescriptor) {
        return realDevice.createQuerySet(desc);
      },

      destroyBuffer(buf: Buffer) {
        return realDevice.destroyBuffer(buf);
      },

      destroyTexture(tex: Texture) {
        return realDevice.destroyTexture(tex);
      },

      createCommandEncoder(desc?: CommandEncoderDescriptor | undefined) {
        const res = realDevice.createCommandEncoder(desc);
        if (!res.ok) return res;
        const cmdId = allocHandleId('commandEncoder');
        pushEvent(s, {
          kind: 'createCommandEncoder',
          cmdHandleId: cmdId,
          desc: desc as Partial<GPUCommandEncoderDescriptor> | undefined,
        });
        const proxyEnc = proxyCmdEncoder(res.value, cmdId);
        return makeOk(proxyEnc as RhiCommandEncoder) as Result<
          RhiCommandEncoder,
          import('@forgeax/engine-rhi').RhiError
        >;
      },
    };
    return d;
  }

  // --------------------------------------------------
  // wrap RhiInstance
  // --------------------------------------------------

  const debugInst: DebugRhiInstance = {
    arm,
    onFrameEnd,
    getTape,
    finalize,
    getState,
    getEvents,
    getBlobPool,
    transitionToError,
    disposeError,
    _pushExternalEvent(event: RhiCallEvent): void {
      pushEvent(s, event);
    },
    _registerShaderModule(handle: ShaderModule, handleId: HandleId): void {
      s.handleMap.set(handle as unknown as object, handleId);
    },
    _pushExternalCreateEvent(handle: object, kind: string, event: RhiCallEvent): HandleId {
      const hId = registerHandle(s, handle, kind, event);
      pushEvent(s, event);
      return hId;
    },
    _getCapturedDevice(): RhiDevice | undefined {
      return s.capturedDevice;
    },
    _getValid(): boolean {
      return s.valid;
    },
    _getBootstrapCreatesSize(): number {
      return s.bootstrapCreates.size;
    },

    async requestAdapter(
      opts?: RequestAdapterOptions | undefined,
      compatibleSurface?: HTMLCanvasElement | OffscreenCanvas | undefined,
    ) {
      const res = await instance.requestAdapter(opts, compatibleSurface);
      if (!res.ok) return res;

      const realAdapter = res.value;
      const proxyAdapter: RhiAdapter = {
        features: realAdapter.features,
        limits: realAdapter.limits,
        async requestDevice(devOpts?: RequestDeviceOptions | undefined) {
          const devRes = await realAdapter.requestDevice(devOpts);
          if (!devRes.ok) return devRes;
          // I-2: capture the live RhiDevice so createDebugRhiAdapter
          // can reach it for replay without a side channel.
          const proxied = proxyDevice(devRes.value);
          s.capturedDevice = proxied;
          return makeOk(proxied) as Result<RhiDevice, import('@forgeax/engine-rhi').RhiError>;
        },
      };
      return makeOk(proxyAdapter) as Result<RhiAdapter, import('@forgeax/engine-rhi').RhiError>;
    },
  };

  return debugInst;
}

// ============================================================================
// wrapCreateShaderModule — standalone wrapper (m2-5)
// ============================================================================

/**
 * Create a recording wrapper around a standalone createShaderModule function.
 *
 * `createShaderModule` in @forgeax/engine-rhi-webgpu is a standalone async
 * function, not a method on RhiDevice. This wrapper intercepts calls and
 * records a `createShaderModule` event in the tape.
 *
 * @param originalFn - The real createShaderModule function.
 * @param debugInst - The DebugRhiInstance (for accessing internal event buffer).
 * @returns A wrapped version of createShaderModule that records events.
 */
export function wrapCreateShaderModule(
  originalFn: CreateShaderModuleFn,
  debugInst: DebugRhiInstance,
): CreateShaderModuleFn {
  return async function wrappedCreateShaderModule(
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ): Promise<Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>> {
    // The renderer threads the proxied RhiDevice (from proxyDevice()) here, but
    // engine-rhi-webgpu's createShaderModule reverse-looks-up the GPUDevice via
    // a WeakMap keyed on the RhiDevice that makeRhiDevice registered. The proxy
    // is a different JS object, so WeakMap.get(proxy) is undefined and the real
    // fn returns shader-compile-failed ("unregistered RhiDevice"). Unwrap the
    // proxy to the registered device via the _realDevice escape hatch that
    // proxyDevice exposes for exactly this purpose.
    const realDevice = (device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device;
    const result = await originalFn(realDevice, desc);
    if (!result.ok) return result;

    // I-12 (round 1 implement-review) fix: route the createShaderModule
    // event through the same `_pushExternalEvent` helper that wraps the
    // internal `pushEvent` (and therefore the `_skipRecord` + state-machine
    // guard). The previous `(events as RhiCallEvent[]).push(...)` cast
    // bypassed those guards — recorder-internal RHI calls during shader
    // construction would have self-polluted the tape.
    const hId = debugInst._pushExternalCreateEvent(result.value, 'shaderModule', {
      kind: 'createShaderModule',
      handleId: '' as HandleId,
      wgslCode: desc.code,
    });
    // Register the shader module handle in the recorder's handleMap so
    // downstream pipeline events (createRenderPipeline / createComputePipeline)
    // can resolve the handleId via getHandleId. Required for cross-device
    // replay: the tape's pipeline desc carries live GPU module objects which
    // are device-bound, so the replayer must swap them with re-created shader
    // modules from the handleMap using the handleId.
    debugInst._registerShaderModule(result.value, hId);

    return result;
  };
}
