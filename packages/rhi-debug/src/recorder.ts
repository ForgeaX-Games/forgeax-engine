// @forgeax/engine-rhi-debug/src/recorder — RhiInstance proxy + state machine + blob pool.
//
// Core architecture:
// - wrap(rhiInstance) produces a DebugRhiInstance extending RhiInstance,
//   with all RHI method calls intercepted and recorded as RhiCallEvents.
// - handleMap: WeakMap<branded handle object, HandleId> for single-level mapping.
// - State machine: idle -> armed -> snapshotting -> recording -> finalizing/error -> idle.
//   (snapshotting: frame-header initial-state capture; copy/submit suppressed from the tape.)
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
import { readbackBufferBytes, readbackTexturePixels } from './readback';
import { assembleReport, finalizeToMemory } from './recorder-core';
import { bytesPerTexel, computeTextureLayout } from './texel-layout';
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

/**
 * True for any depth / stencil texture format. Their content is render-pass
 * output (shadow maps, z-buffers), never an uploaded byte payload, and
 * queue.writeTexture rejects them (no CopyDst), so the frame-header snapshot
 * loop skips them rather than emitting an un-seedable initialData event.
 */
function isDepthOrStencilFormat(format: GPUTextureFormat | undefined): boolean {
  return format !== undefined && (format.startsWith('depth') || format.startsWith('stencil'));
}

/**
 * True for a texture the frame-header snapshot can read back AND re-seed
 * faithfully: any uncompressed color format whose texel byte size is known
 * (`bytesPerTexel`), at any array-layer count and any mip count. The
 * readback + seed path (readbackTexturePixels + computeTextureLayout +
 * replayInitialData) walks every (layer, mip) subresource with the correct
 * bytesPerRow = mipWidth * bytesPerTexel, so rgba16float (8 B), cubemaps
 * (6 layers), and mip chains (e.g. the IBL prefilter map: rgba16float / 6
 * layers / 5 mips) all round-trip.
 *
 * Still skipped (no faithful path today, Fail Fast rather than corrupt seed):
 * - depth/stencil formats: queue.writeTexture rejects them (no CopyDst seed).
 * - block-compressed formats (bc/etc/astc): texel != byte-addressable row, not
 *   in the bytesPerTexel table -> returns undefined -> skipped.
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
  // Round-trippable iff its texel byte size is known (uncompressed color).
  return bytesPerTexel(format) !== undefined;
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

import { TAPE_FORMAT_VERSION } from './tape-format';

export { generateRunId } from './recorder-core';
export { TAPE_FORMAT_VERSION };

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
 * Narrow a readbackBufferBytes failure to a snapshot-readback-failed stage.
 * readbackBufferBytes already tags `.detail.stage` with 'copy' | 'map'; carry
 * it through so the re-wrapped error preserves the failure point. Falls back to
 * 'copy' when the inner error lacks a snapshot detail.
 */
function snapshotStageOf(error: DebugError): 'copy' | 'map' | 'store' {
  const d = error.detail;
  if (
    d !== undefined &&
    'stage' in d &&
    (d.stage === 'copy' || d.stage === 'map' || d.stage === 'store')
  ) {
    return d.stage;
  }
  return 'copy';
}

/**
 * Project a recorded texture extent (number | {width,height?,...} | [w,h?,d?])
 * onto {width, height} for readbackTexturePixels. Mirrors the extent handling
 * in readback.resolveAttachmentSize so the two readback entry points agree on
 * extent interpretation.
 */
function extentToWidthHeight(size: number | GPUExtent3DStrict | undefined): {
  width: number;
  height: number;
} {
  if (size === undefined) return { width: 1, height: 1 };
  if (typeof size === 'number') return { width: size, height: 1 };
  if (Array.isArray(size)) {
    const w = typeof size[0] === 'number' ? size[0] : 1;
    const h = typeof size[1] === 'number' ? size[1] : w;
    return { width: w, height: h };
  }
  const obj = size as { width: number; height?: number };
  const w = typeof obj.width === 'number' ? obj.width : 1;
  const h = typeof obj.height === 'number' ? obj.height : w;
  return { width: w, height: h };
}

/**
 * Project a recorded texture extent onto its array-layer count
 * (depthOrArrayLayers). A cubemap is 6 layers; a plain 2D texture is 1. The
 * snapshot blob covers every layer, so the layout helper needs this.
 */
function extentLayerCount(size: number | GPUExtent3DStrict | undefined): number {
  if (size === undefined || typeof size === 'number') return 1;
  if (Array.isArray(size)) return typeof size[2] === 'number' ? size[2] : 1;
  const obj = size as { depthOrArrayLayers?: number };
  return typeof obj.depthOrArrayLayers === 'number' ? obj.depthOrArrayLayers : 1;
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
  if (
    s.state !== RecorderState.Armed &&
    s.state !== RecorderState.Recording &&
    s.state !== RecorderState.Snapshotting
  ) {
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
function _collectFrameReferencedHandleIds(events: readonly RhiCallEvent[]): Set<HandleId> {
  const refs = new Set<HandleId>();
  for (const e of events) {
    switch (e.kind) {
      case 'writeBuffer':
      case 'clearBuffer':
      // initialData seeds a pre-arm resource's bytes; its handleId must be
      // prefix-pulled so the resource's create* event lands in the bootstrap
      // closure (otherwise the tape references a handle with no create event ->
      // tape-handle-graph-broken on deserialize).
      case 'initialData': {
        const we = e as { handleId: HandleId };
        refs.add(we.handleId);
        break;
      }
      case 'setVertexBuffer': {
        const we = e as { passHandleId: HandleId; bufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setIndexBuffer': {
        const we = e as { passHandleId: HandleId; bufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setPipeline': {
        const we = e as { passHandleId: HandleId; pipelineHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setComputePipeline': {
        const we = e as { passHandleId: HandleId; pipelineHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setBindGroup': {
        const we = e as { passHandleId: HandleId; bindGroupHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bindGroupHandleId);
        break;
      }
      case 'draw': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'drawIndexed': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setViewport': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setScissorRect': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setBlendConstant': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setStencilReference': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'drawIndirect': {
        const we = e as { passHandleId: HandleId; indirectBufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.indirectBufferHandleId);
        break;
      }
      case 'drawIndexedIndirect': {
        const we = e as { passHandleId: HandleId; indirectBufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.indirectBufferHandleId);
        break;
      }
      case 'passPushDebugGroup': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'passPopDebugGroup': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'passInsertDebugMarker': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'endRenderPass': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'dispatchWorkgroups': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'endComputePass': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'submit': {
        const we = e as { cmdHandleIds: readonly HandleId[] };
        for (const id of we.cmdHandleIds) refs.add(id);
        break;
      }
      case 'beginRenderPass': {
        const we = e as {
          cmdHandleId: HandleId;
          colorAttachmentViewHandleIds: readonly (HandleId | undefined)[];
          depthStencilViewHandleId?: HandleId;
        };
        refs.add(we.cmdHandleId);
        for (const vhId of we.colorAttachmentViewHandleIds) {
          if (vhId !== undefined) refs.add(vhId);
        }
        if (we.depthStencilViewHandleId !== undefined) refs.add(we.depthStencilViewHandleId);
        break;
      }
      case 'beginComputePass': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'finish': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'pushDebugGroup':
      case 'popDebugGroup':
      case 'insertDebugMarker': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'writeTexture': {
        const we = e as { destination: { textureHandleId: HandleId } };
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyExternalImageToTexture': {
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
      case 'createBindGroup':
      case 'createPipelineLayout':
      case 'createRenderPipeline':
      case 'createComputePipeline':
      case 'createTextureView': {
        // An in-frame-created resource may reference a PRE-ARM resource via its
        // backward edges (e.g. a composite/FXAA bind group built mid-frame that
        // samples a scratch TextureView created at setup; or an in-frame
        // createTextureView of a pre-arm texture). Those pre-arm handles are
        // reachable ONLY through this create* event's backward refs — no usage
        // event names them directly — so without collecting them here they never
        // become prefix seeds and the tape deserializes as non-self-contained
        // (tape-handle-graph-broken). Collect the edges; getTape's prefixSeedIds
        // filter then drops any that are themselves in-frame declared, leaving
        // only the genuinely pre-arm dependencies to seed the bootstrap closure.
        for (const ref of _getCreateEventReferencedHandleIds(e)) refs.add(ref);
        break;
      }
      case 'frameMark':
      case 'createBuffer':
      case 'createTexture':
      case 'createSampler':
      case 'createBindGroupLayout':
      case 'createShaderModule':
      case 'createCommandEncoder':
        // Leaf declaration events — no backward references to collect.
        break;
      default: {
        // Exhaustiveness guard: if a new RhiCallEvent member is added to the
        // union without a corresponding handle-collection case, tsc fails here.
        // This prevents silent omission of handle references (tape-handle-graph-broken).
        const _exhaustive: never = e;
        void _exhaustive;
        break;
      }
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
   * Snapshot a resource's GPU bytes into the tape as an initialData event.
   *
   * Reads the resource descriptor from the internal registry, copies the
   * resource's bytes via copyToBuffer/mapAsync, stores the bytes into the
   * blobPool (djb2 hash-dedup), and pushes an RhiCallEventInitialData into
   * the event stream. Returns Result with {handleId, dataHash} on success,
   * or snapshot-readback-failed on any readback/storeBlob failure.
   *
   * Async: the GPU readback chain (copyToBuffer -> submit ->
   * onSubmittedWorkDone -> mapAsync) is inherently asynchronous.
   */
  snapshotResource(
    handleId: HandleId,
  ): Promise<Result<{ handleId: HandleId; dataHash: string }, DebugError>>;
  /**
   * Frame-header snapshot loop: awaits all submitted GPU work, then snapshots
   * every live resource in the descriptor registry (full-table dump, no
   * trimming). Advances the recorder Armed -> Snapshotting -> Recording on
   * success. Returns the first snapshot failure as a Result so the caller can
   * fail fast rather than record a partial seed set.
   */
  snapshotAllLiveResources(): Promise<Result<void, DebugError>>;
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
  /**
   * @internal
   * Read-only view of the descriptor registry keyed by handleId. Test-only
   * accessor so unit tests can verify create* register / destroy* remove
   * semantics (AC-09) without reaching into the closed-over recorder state.
   */
  _getDescriptorTable(): ReadonlyMap<
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
    descriptorTable: new Map(),
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
      s.state === RecorderState.Snapshotting ||
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

    // Snapshotting = the async frame-header snapshot loop is mid-flight. Its
    // readbacks await between resources, so the host rAF loop CAN fire
    // onFrameEnd while the loop is still pushing initialData events. If we let
    // that tick advance the state machine (Recording -> frameMark -> Finalizing
    // -> Idle), the still-running snapshot loop's later pushEvent() calls hit
    // the Idle gate and are silently dropped -- the exact race that lost every
    // texture initialData (material default textures all-zero -> black cube).
    // Ignore the tick entirely: snapshotAllLiveResources() sets Recording when
    // it completes, and the NEXT onFrameEnd records the real frame.
    if (s.state === RecorderState.Snapshotting) {
      s.bootstrap = false;
      return;
    }

    // Armed at frame end -> recording. This is the fallback for hosts that
    // never call snapshotAllLiveResources() (the snapshot loop is opt-in at the
    // seam); they record straight from Armed with no frame-header snapshot.
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
    // Collect handleIds that are directly declared by create* events in s.events.
    // Only include the handleId field of the create event itself — NOT backward-refs
    // (layoutHandleId, resourceHandleIds, etc.) from _getCreateEventReferencedHandleIds.
    //
    // Backward-refs from in-frame create events often point to persistent resources
    // (buffers, textures, pipelines) that were created before arm(). Including them
    // in inFrameHandleIds would exclude those resources from bootstrap prefixing,
    // causing tapes to be non-self-contained (missing create* events for early handles).
    //
    // Swapchain textures that have no createTexture event are handled elsewhere:
    // createTextureView (line 1237) detects missing bootstrap entries and constructs
    // faithful createTexture events at capture time, so they are already in both
    // bootstrapCreates and s.events.
    const inFrameHandleIds = new Set<HandleId>();
    for (const e of s.events) {
      // create* events declare handleId (or resultHandleId for createTextureView).
      if (
        e.kind.startsWith('create') &&
        'handleId' in e &&
        typeof (e as { handleId: unknown }).handleId === 'string'
      ) {
        inFrameHandleIds.add((e as { handleId: HandleId }).handleId);
      }
      // createTextureView declares the result via resultHandleId.
      if (
        e.kind === 'createTextureView' &&
        'resultHandleId' in e &&
        typeof (e as { resultHandleId: unknown }).resultHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { resultHandleId: HandleId }).resultHandleId);
      }
      // createCommandEncoder declares the cmd via cmdHandleId.
      if (
        e.kind === 'createCommandEncoder' &&
        'cmdHandleId' in e &&
        typeof (e as { cmdHandleId: unknown }).cmdHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { cmdHandleId: HandleId }).cmdHandleId);
      }
      // beginRenderPass / beginComputePass declare passHandleId.
      if (
        (e.kind === 'beginRenderPass' || e.kind === 'beginComputePass') &&
        'passHandleId' in e &&
        typeof (e as { passHandleId: unknown }).passHandleId === 'string'
      ) {
        inFrameHandleIds.add((e as { passHandleId: HandleId }).passHandleId);
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

  /**
   * Snapshot a resource's GPU bytes into the tape as an initialData event.
   *
   * Reads the resource shape from the descriptor registry, copies the bytes
   * back from the GPU via readbackBufferBytes (buffer) / readbackTexturePixels
   * (texture), stores them in the blobPool (djb2 hash-dedup), and pushes an
   * `initialData` event into the stream. The snapshot's own copy/submit are
   * wrapped in `_skipRecord = true` so they never leak into the tape event
   * stream (D-8 isolation).
   *
   * Async because the GPU readback chain (copyToBuffer -> submit ->
   * onSubmittedWorkDone -> mapAsync) is inherently asynchronous; the M1 stub
   * locked a sync signature, but no caller existed yet — the frame-header loop
   * added here is the first consumer (Change stance: optimal > compatible).
   *
   * Returns Result with {handleId, dataHash} on success, or
   * snapshot-readback-failed (with `.detail = {handleId, stage}`) on any
   * failure, so AI users can switch-exhaustive narrow the code (D-3).
   */
  async function snapshotResource(
    handleId: HandleId,
  ): Promise<Result<{ handleId: HandleId; dataHash: string }, DebugError>> {
    type SnapshotResult = Result<{ handleId: HandleId; dataHash: string }, DebugError>;
    const fail = (
      stage: 'copy' | 'map' | 'store',
      expected: string,
      hint: string,
    ): SnapshotResult =>
      makeErr(
        new DebugError({
          code: 'snapshot-readback-failed',
          expected,
          hint,
          detail: { handleId, stage },
        }),
      ) as unknown as SnapshotResult;

    const entry = s.descriptorTable.get(handleId);
    if (entry === undefined) {
      return fail(
        'copy',
        'handleId present in descriptor registry',
        `no live resource registered for handleId '${handleId}'; it may have been destroyed or never created through the recorder proxy`,
      );
    }

    const device = s.capturedDevice;
    if (device === undefined) {
      return fail(
        'copy',
        'a captured RhiDevice to drive GPU readback',
        'no device has been acquired through the recorder proxy yet; drive requestAdapter().requestDevice() before snapshotting',
      );
    }

    // Resolve the unwrapped real device — readback issues copy/submit/mapAsync
    // through it. The proxy device would re-record those calls were it not for
    // the _skipRecord guard below; using the real device sidesteps the proxy
    // entirely for the readback staging buffer.
    const realDevice = (device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device;

    let bytes: ArrayBuffer;
    const prevSkip = s._skipRecord;
    s._skipRecord = true;
    try {
      if (entry.kind === 'buffer') {
        const size = typeof entry.size === 'number' ? entry.size : 0;
        const res = await readbackBufferBytes(realDevice, entry.resource, size);
        if (!res.ok) return fail(snapshotStageOf(res.error), res.error.expected, res.error.hint);
        bytes = res.value;
      } else {
        const { width, height } = extentToWidthHeight(entry.size);
        const layout = computeTextureLayout(
          entry.format,
          width,
          height,
          extentLayerCount(entry.size),
          entry.mipLevelCount ?? 1,
        );
        if (layout === undefined) {
          // Should not happen: the snapshot loop's isSnapshottableColorTexture
          // gate already excludes formats with no texel size. Fail fast rather
          // than emit a corrupt seed.
          return fail(
            'copy',
            'a snapshottable color format with a known texel size',
            `format '${entry.format}' has no byte layout; the snapshot gate should have skipped it`,
          );
        }
        try {
          // Read every (layer, mip) subresource and concatenate tight into one
          // blob in the canonical order computeTextureLayout defines; the seed
          // side walks the same layout to writeTexture each slice back.
          const blob = new Uint8Array(layout.totalBytes);
          for (const slice of layout.slices) {
            const sub = await readbackTexturePixels(
              realDevice,
              entry.resource,
              slice.width,
              slice.height,
              {
                bytesPerTexel: layout.bytesPerTexel,
                mipLevel: slice.mip,
                baseArrayLayer: slice.layer,
              },
            );
            blob.set(sub.subarray(0, slice.byteLength), slice.byteOffset);
          }
          bytes = blob.buffer.slice(
            blob.byteOffset,
            blob.byteOffset + blob.byteLength,
          ) as ArrayBuffer;
        } catch (e) {
          return fail(
            'copy',
            'texture GPU byte readback to succeed',
            `readbackTexturePixels failed: ${String(e)}`,
          );
        }
      }
    } finally {
      s._skipRecord = prevSkip;
    }

    // storeBlob: djb2 hash-dedup into the unified blobPool (D-1, no separate
    // init-data pool). Reuses the same tag space as writeBuffer/writeTexture.
    let dataHash: string;
    try {
      dataHash = storeBlob(s, bytes);
    } catch (e) {
      return fail(
        'store',
        'storeBlob to hash + insert the snapshot bytes',
        `storeBlob failed: ${String(e)}`,
      );
    }

    pushEvent(s, { kind: 'initialData', handleId, dataHash });
    return makeOk({ handleId, dataHash }) as unknown as SnapshotResult;
  }

  /**
   * Frame-header snapshot loop (D-5, C-3, C-4): with the recorder in the
   * Snapshotting middle state, await all submitted work, then snapshot every
   * live resource in the descriptor registry (full-table dump, no size
   * threshold / allowlist trimming — that for-loop is the single Phase 2
   * policy seam, OOS-4 / OOS-5). On full success the recorder advances to
   * Recording; any single snapshot failure aborts with its Result so the
   * caller fails fast (architecture §5) rather than recording a partial seed.
   */
  async function snapshotAllLiveResources(): Promise<Result<void, DebugError>> {
    if (s.state !== RecorderState.Armed && s.state !== RecorderState.Snapshotting) {
      return makeErr(
        new DebugError({
          code: 'recorder-not-attached',
          expected: 'snapshotAllLiveResources called while recorder is armed',
          hint: `recorder is in '${s.state}' state; call arm() before the frame-header snapshot`,
        }),
      ) as unknown as Result<void, DebugError>;
    }
    s.state = RecorderState.Snapshotting;

    // C-3 conservative timing: drain queued work so snapshots read frame-outside
    // / historical content, never a half-written in-frame value (A-2).
    const device = s.capturedDevice;
    if (device !== undefined) {
      const realDevice = (device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device;
      const prevSkip = s._skipRecord;
      s._skipRecord = true;
      try {
        await realDevice.queue.onSubmittedWorkDone();
      } finally {
        s._skipRecord = prevSkip;
      }
    }

    for (const [handleId, entry] of s.descriptorTable.entries()) {
      // Skip mappable (MAP_READ/WRITE) staging buffers: promoteBufferUsage never
      // gives them COPY_SRC, so readbackBufferBytes' copyBufferToBuffer throws
      // "usage doesn't include CopySrc" (e.g. shadow-probe-staging on shadow/IBL
      // demos). Their bytes are transient readback scratch, never seed payload.
      if (entry.kind === 'buffer' && isMappableBuffer(entry.usage)) {
        continue;
      }
      // Skip textures the readback/seed path cannot round-trip faithfully today:
      // depth/stencil (render-pass output, writeTexture rejects them) and any
      // non-4-byte-per-texel or multi-layer color format (rgba16float, IBL
      // cubemaps) whose byte layout the width*4 / single-layer seed path gets
      // wrong. Emitting an initialData for these would throw on replay; skipping
      // is correct-but-incomplete rather than silently-corrupt (Fail Fast).
      if (
        entry.kind === 'texture' &&
        (isDepthOrStencilFormat(entry.format) ||
          !isSnapshottableColorTexture(entry.format, entry.size, entry.sampleCount))
      ) {
        continue;
      }
      const res = await snapshotResource(handleId);
      if (!res.ok) return res as unknown as Result<void, DebugError>;
    }

    s.state = RecorderState.Recording;
    return makeOk(undefined) as unknown as Result<void, DebugError>;
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
        pushEvent(s, {
          kind: 'setViewport',
          passHandleId: passHId,
          x,
          y,
          w,
          h,
          minDepth: minDepth ?? 0,
          maxDepth: maxDepth ?? 1,
        });
        realPass.setViewport(x, y, w, h, minDepth, maxDepth);
      },
      setScissorRect(x, y, w, h) {
        pushEvent(s, {
          kind: 'setScissorRect',
          passHandleId: passHId,
          x,
          y,
          w,
          h,
        });
        realPass.setScissorRect(x, y, w, h);
      },
      setBlendConstant(color) {
        pushEvent(s, {
          kind: 'setBlendConstant',
          passHandleId: passHId,
          color,
        });
        realPass.setBlendConstant(color);
      },
      setStencilReference(reference) {
        // Recorded (not a no-op pass-through): stencil pipelines compare against
        // this dynamic reference, so without it replay defaults ref=0 and any
        // not-equal/equal stencil test (e.g. the 4.2 stencil-testing outline
        // pass) silently breaks -- the outline vanishes on replay.
        pushEvent(s, {
          kind: 'setStencilReference',
          passHandleId: passHId,
          reference,
        });
        realPass.setStencilReference(reference);
      },
      drawIndirect(indirectBuffer, indirectOffset) {
        const ibId = getHandleId(s, indirectBuffer as unknown as object, 'buffer');
        pushEvent(s, {
          kind: 'drawIndirect',
          passHandleId: passHId,
          indirectBufferHandleId: ibId,
          indirectOffset,
        });
        realPass.drawIndirect(indirectBuffer, indirectOffset);
      },
      drawIndexedIndirect(indirectBuffer, indirectOffset) {
        const ibId = getHandleId(s, indirectBuffer as unknown as object, 'buffer');
        pushEvent(s, {
          kind: 'drawIndexedIndirect',
          passHandleId: passHId,
          indirectBufferHandleId: ibId,
          indirectOffset,
        });
        realPass.drawIndexedIndirect(indirectBuffer, indirectOffset);
      },
      pushDebugGroup(groupLabel) {
        pushEvent(s, {
          kind: 'passPushDebugGroup',
          passHandleId: passHId,
          groupLabel,
        });
        realPass.pushDebugGroup(groupLabel);
      },
      popDebugGroup() {
        pushEvent(s, { kind: 'passPopDebugGroup', passHandleId: passHId });
        realPass.popDebugGroup();
      },
      insertDebugMarker(markerLabel) {
        pushEvent(s, {
          kind: 'passInsertDebugMarker',
          passHandleId: passHId,
          markerLabel,
        });
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
          // 5-arg form: (source, sourceOffset, destination, destinationOffset, size)
          const sourceId = getHandleId(s, args[0] as unknown as object, 'buffer');
          const destinationId = getHandleId(s, args[2] as unknown as object, 'buffer');
          pushEvent(s, {
            kind: 'copyBufferToBuffer',
            cmdHandleId: cmdHId,
            sourceHandleId: sourceId,
            sourceOffset: args[1] as number,
            destinationHandleId: destinationId,
            destinationOffset: args[3] as number,
            size: args[4] as number,
          });
          (realEnc.copyBufferToBuffer as unknown as (...args: unknown[]) => void)(...args);
        } else {
          // 3-arg form: (source, destination, size?)
          const sourceId = getHandleId(s, args[0] as unknown as object, 'buffer');
          const destinationId = getHandleId(s, args[1] as unknown as object, 'buffer');
          const size = args[2] as number | undefined;
          pushEvent(s, {
            kind: 'copyBufferToBuffer',
            cmdHandleId: cmdHId,
            sourceHandleId: sourceId,
            sourceOffset: 0,
            destinationHandleId: destinationId,
            destinationOffset: 0,
            size: (size ?? 0) as number,
          });
          realEnc.copyBufferToBuffer(args[0] as Buffer, args[1] as Buffer, size);
        }
      },
      copyBufferToTexture(source, destination, copySize) {
        const bufId = getHandleId(
          s,
          (source as { buffer: object }).buffer as unknown as object,
          'buffer',
        );
        const texId = getHandleId(
          s,
          (destination as { texture: object }).texture as unknown as object,
          'texture',
        );
        const dstPayload: Record<string, unknown> = { textureHandleId: texId };
        if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
        if (destination.origin !== undefined) dstPayload.origin = destination.origin;
        if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
        pushEvent(s, {
          kind: 'copyBufferToTexture',
          cmdHandleId: cmdHId,
          source: {
            bufferHandleId: bufId,
            offset: source.offset ?? 0,
            bytesPerRow: source.bytesPerRow ?? 0,
            rowsPerImage: source.rowsPerImage ?? 0,
          },
          destination: dstPayload as unknown as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
            readonly textureHandleId: HandleId;
          },
          copySize,
        });
        realEnc.copyBufferToTexture(source, destination, copySize);
      },
      copyTextureToBuffer(source, destination, copySize) {
        const texId = getHandleId(
          s,
          (source as { texture: object }).texture as unknown as object,
          'texture',
        );
        const bufId = getHandleId(
          s,
          (destination as { buffer: object }).buffer as unknown as object,
          'buffer',
        );
        const srcPayload: Record<string, unknown> = { textureHandleId: texId };
        if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
        if (source.origin !== undefined) srcPayload.origin = source.origin;
        if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
        pushEvent(s, {
          kind: 'copyTextureToBuffer',
          cmdHandleId: cmdHId,
          source: srcPayload as unknown as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
            readonly textureHandleId: HandleId;
          },
          destination: {
            bufferHandleId: bufId,
            offset: destination.offset ?? 0,
            bytesPerRow: destination.bytesPerRow ?? 0,
            rowsPerImage: destination.rowsPerImage ?? 0,
          },
          copySize,
        });
        realEnc.copyTextureToBuffer(source, destination, copySize);
      },
      copyTextureToTexture(source, destination, copySize) {
        const srcTexId = getHandleId(
          s,
          (source as { texture: object }).texture as unknown as object,
          'texture',
        );
        const dstTexId = getHandleId(
          s,
          (destination as { texture: object }).texture as unknown as object,
          'texture',
        );
        const srcPayload: Record<string, unknown> = { textureHandleId: srcTexId };
        if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
        if (source.origin !== undefined) srcPayload.origin = source.origin;
        if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
        const dstPayload: Record<string, unknown> = { textureHandleId: dstTexId };
        if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
        if (destination.origin !== undefined) dstPayload.origin = destination.origin;
        if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
        pushEvent(s, {
          kind: 'copyTextureToTexture',
          cmdHandleId: cmdHId,
          source: srcPayload as unknown as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
            readonly textureHandleId: HandleId;
          },
          destination: dstPayload as unknown as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
            readonly textureHandleId: HandleId;
          },
          copySize,
        });
        realEnc.copyTextureToTexture(source, destination, copySize);
      },
      clearBuffer(buffer, offset, size) {
        const bufId = getHandleId(s, buffer as unknown as object, 'buffer');
        pushEvent(s, {
          kind: 'clearBuffer',
          cmdHandleId: cmdHId,
          handleId: bufId,
          offset,
          size,
        });
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
        pushEvent(s, { kind: 'pushDebugGroup', cmdHandleId: cmdHId, groupLabel });
        realEnc.pushDebugGroup(groupLabel);
      },
      popDebugGroup() {
        pushEvent(s, { kind: 'popDebugGroup', cmdHandleId: cmdHId });
        realEnc.popDebugGroup();
      },
      insertDebugMarker(markerLabel) {
        pushEvent(s, { kind: 'insertDebugMarker', cmdHandleId: cmdHId, markerLabel });
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
        // COPY_SRC promotion (D-5): every recorded resource must be readable
        // back via copyBufferToBuffer so snapshotResource can capture its GPU
        // bytes at frame-header time. Promote the live resource's usage too,
        // not just the recorded event — a buffer created without COPY_SRC is
        // an invalid copy source on the real device. Mappable buffers are
        // skipped (MAP_READ|COPY_SRC is invalid) — they are staging buffers,
        // never snapshot targets.
        const promotedUsage = promoteBufferUsage(desc.usage ?? 0);
        const res = realDevice.createBuffer({ ...desc, usage: promotedUsage });
        if (!res.ok) return res;
        const event: RhiCallEvent = {
          kind: 'createBuffer',
          handleId: '' as HandleId,
          desc: {
            size: desc.size ?? 0,
            usage: promotedUsage,
            mappedAtCreation: desc.mappedAtCreation,
          },
        };
        const bufResource = res.value as unknown as object;
        const bufHandleId = registerHandle(s, bufResource, 'buffer', event);
        s.descriptorTable.set(bufHandleId, {
          kind: 'buffer',
          size: desc.size ?? 0,
          usage: promotedUsage,
          resource: bufResource,
        });
        pushEvent(s, event);
        return res;
      },

      createTexture(desc: TextureDescriptor) {
        // COPY_SRC promotion (D-5): same rationale as createBuffer — a texture
        // without COPY_SRC cannot be a copyTextureToBuffer source, so promote
        // the live resource's usage as well as the recorded event's. The
        // swapchain-reconstruction path (createTextureView below) already does
        // this for the synthetic createTexture it emits. Texture COPY_SRC is
        // 0x01 (distinct from the buffer bit 0x04).
        const promotedUsage = (desc.usage ?? 0) | TEXTURE_USAGE_COPY_SRC;
        const res = realDevice.createTexture({ ...desc, usage: promotedUsage });
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
            usage: promotedUsage,
            viewFormats: desc.viewFormats,
            textureBindingViewDimension: desc.textureBindingViewDimension,
          },
        };
        const texResource = res.value as unknown as object;
        const texHandleId = registerHandle(s, texResource, 'texture', event);
        s.descriptorTable.set(texHandleId, {
          kind: 'texture',
          size: desc.size ?? { width: 1, height: 1 },
          format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
          ...(desc.sampleCount !== undefined ? { sampleCount: desc.sampleCount } : {}),
          ...(desc.mipLevelCount !== undefined ? { mipLevelCount: desc.mipLevelCount } : {}),
          usage: promotedUsage,
          resource: texResource,
        });
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
          entries: entries.map((e, idx) => {
            const entry: {
              binding: number;
              resourceKind: RhiBindResourceKind;
              bufferOffset?: number;
              bufferSize?: number;
            } = {
              binding: e.binding,
              resourceKind: resourceKinds[idx] as RhiBindResourceKind,
            };
            // Capture the bound sub-range for buffer entries so a
            // dynamic-offset slice (e.g. a 256 B view of a 256 KiB pool)
            // replays as that slice, not the whole buffer.
            if (e.resource.kind === 'buffer') {
              const { offset, size } = e.resource.value;
              if (offset !== undefined) entry.bufferOffset = offset;
              if (size !== undefined) entry.bufferSize = size;
            }
            return entry;
          }),
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
        const hId = s.handleMap.get(buf as unknown as object);
        if (hId !== undefined) s.descriptorTable.delete(hId);
        return realDevice.destroyBuffer(buf);
      },

      destroyTexture(tex: Texture) {
        const hId = s.handleMap.get(tex as unknown as object);
        if (hId !== undefined) s.descriptorTable.delete(hId);
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
    snapshotResource,
    snapshotAllLiveResources,
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
    _getDescriptorTable() {
      return s.descriptorTable;
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
