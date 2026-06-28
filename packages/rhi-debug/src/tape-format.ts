// @forgeax/engine-rhi-debug/src/tape-format — serialize / deserialize round-trip for Tape.
//
// Shape:
// - serializeTape(tape: Tape): { json: string; blob: Uint8Array }
//   json contains events array + formatVersion + rhiCapsRecorded + blobPool offset/size refs.
//   blob is the concatenation of all unique blobs, deduplicated by hash.
// - deserializeTape(json: string, blob: Uint8Array): Result<Tape, DebugError>
//   reconstructs Tape from json + blob byte stream.
// - formatVersion != TAPE_FORMAT_VERSION -> reject 'tape-format-version-mismatch'.
// - dangling handleId references -> reject 'tape-handle-graph-broken'.
//
// Related: requirements AC-04/AC-06/AC-16; plan-strategy D-2; m4-1 / m4-2.

/// <reference types="@webgpu/types" />

import { DebugError } from './errors';
import type {
  HandleId,
  RhiCallEvent,
  RhiCallEventBeginComputePass,
  RhiCallEventBeginRenderPass,
  RhiCallEventClearBuffer,
  RhiCallEventCopyBufferToBuffer,
  RhiCallEventCopyBufferToTexture,
  RhiCallEventCopyExternalImageToTexture,
  RhiCallEventCopyTextureToBuffer,
  RhiCallEventCopyTextureToTexture,
  RhiCallEventCreateBindGroup,
  RhiCallEventCreateBuffer,
  RhiCallEventCreateCommandEncoder,
  RhiCallEventCreateComputePipeline,
  RhiCallEventCreatePipelineLayout,
  RhiCallEventCreateRenderPipeline,
  RhiCallEventCreateTextureView,
  RhiCallEventDispatchWorkgroups,
  RhiCallEventDraw,
  RhiCallEventDrawIndexed,
  RhiCallEventEndComputePass,
  RhiCallEventEndRenderPass,
  RhiCallEventInitialData,
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

export const TAPE_FORMAT_VERSION = 3 as const;

/**
 * Set of tape format versions accepted by this runtime's deserializer.
 * v2 tapes (with initialData events, without new v3 event kinds) are
 * accepted via backward-compat; new v3 events are naturally absent in
 * v2 data (D-9). serialize always writes `formatVersion = TAPE_FORMAT_VERSION` (3).
 */
export const SUPPORTED_TAPE_VERSIONS = new Set<number>([2, 3]);

// ============================================================================
// Local Result factories (mirrors recorder.ts pattern)
// ============================================================================

interface ResultOk<T> {
  readonly ok: true;
  readonly value: T;
}

interface ResultErr<E> {
  readonly ok: false;
  readonly error: E;
}

type Result<T, E> = ResultOk<T> | ResultErr<E>;

function makeOk<T>(value: T): ResultOk<T> {
  return { ok: true, value } as ResultOk<T>;
}

function makeErr<E>(error: E): ResultErr<E> {
  return { ok: false, error } as ResultErr<E>;
}

// ============================================================================
// Serialized representations
// ============================================================================

/**
 * Wire-format representation of a blob storage entry.
 * Each blob is stored by its hash in the concatenated binary blob stream;
 * offset and size allow deserialization to reconstruct the blobPool Map.
 */
interface SerializedBlobEntry {
  readonly hash: string;
  readonly offset: number;
  readonly size: number;
}

interface SerializedTapeHeader {
  readonly formatVersion: number;
  readonly rhiCapsRecorded: RhiCapsRecorded;
  readonly blobEntries: readonly SerializedBlobEntry[];
}

// ============================================================================
// serializeTape
// ============================================================================

/**
 * Serialize a Tape into json (events + header) + binary blob pool.
 *
 * Blob pool dedup: blobs with the same hash are stored once in the binary
 * stream. The json contains blobEntries with offset + size for each unique
 * blob, keyed by hash. Events retain their dataHash / wgslCode references
 * as-is (the hash string is the key into blobPool on both sides).
 *
 * @returns json string (events + formatVersion + rhiCapsRecorded + blobEntries)
 *          and binary blob (concatenation of all unique blob ArrayBuffers).
 */
export function serializeTape(tape: Tape): { json: string; blob: Uint8Array } {
  const uniqueHashes = Array.from(tape.blobPool.keys());
  const blobEntries: SerializedBlobEntry[] = [];
  const parts: Uint8Array[] = [];
  let currentOffset = 0;

  for (const hash of uniqueHashes) {
    const data = tape.blobPool.get(hash);
    if (data === undefined) continue;
    const bytes = new Uint8Array(data);
    const size = bytes.byteLength;
    blobEntries.push({ hash, offset: currentOffset, size });
    parts.push(bytes);
    currentOffset += size;
  }

  const blob = new Uint8Array(currentOffset);
  let writePos = 0;
  for (const part of parts) {
    blob.set(part, writePos);
    writePos += part.byteLength;
  }

  const header: SerializedTapeHeader = {
    formatVersion: tape.formatVersion,
    rhiCapsRecorded: tape.rhiCapsRecorded,
    blobEntries,
  };

  const json = JSON.stringify({
    header,
    events: tape.events,
  });

  return { json, blob };
}

// ============================================================================
// deserializeTape
// ============================================================================

/**
 * Deserialize a Tape from json + binary blob stream.
 *
 * Validation checks (m4-2):
 * - formatVersion != TAPE_FORMAT_VERSION -> tape-format-version-mismatch
 * - dangling handleId references -> tape-handle-graph-broken
 *
 * @param json - JSON string from serializeTape.
 * @param blob - Binary blob stream from serializeTape.
 * @returns Ok(Tape) or Err(DebugError) on validation failure.
 */
export function deserializeTape(json: string, blob: Uint8Array): Result<Tape, DebugError> {
  let parsed: { header: SerializedTapeHeader; events: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    return makeErr(
      new DebugError({
        code: 'tape-format-version-mismatch',
        expected: `valid JSON tape data with formatVersion = ${TAPE_FORMAT_VERSION}`,
        hint: 'the JSON input is not valid JSON; the tape file may be corrupted',
        detail: {
          tapeVersion: -1,
          expectedVersion: TAPE_FORMAT_VERSION,
        },
      }),
    );
  }

  let header: SerializedTapeHeader;
  let events: unknown;
  if (typeof parsed === 'object' && parsed !== null && 'header' in parsed && 'events' in parsed) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    header = parsed.header as SerializedTapeHeader;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    events = parsed.events;
  } else {
    return makeErr(
      new DebugError({
        code: 'tape-format-version-mismatch',
        expected: `JSON object with 'header' and 'events' fields`,
        hint: 'the JSON input has unexpected shape; the tape file may be corrupted',
        detail: {
          tapeVersion: -1,
          expectedVersion: TAPE_FORMAT_VERSION,
        },
      }),
    );
  }

  // formatVersion reject: accept SUPPORTED_TAPE_VERSIONS (D-2: {2,3})
  if (!SUPPORTED_TAPE_VERSIONS.has(header.formatVersion)) {
    const supported = Array.from(SUPPORTED_TAPE_VERSIONS).join(', ');
    return makeErr(
      new DebugError({
        code: 'tape-format-version-mismatch',
        expected: `formatVersion ∈ {${supported}}`,
        hint: `this runtime accepts formatVersion ${supported} but the tape has formatVersion ${header.formatVersion}; re-record the tape with a compatible runtime`,
        detail: {
          tapeVersion: header.formatVersion,
          expectedVersion: TAPE_FORMAT_VERSION,
        },
      }),
    );
  }

  // Reconstruct blobPool from blob byte stream
  const blobPool = new Map<string, ArrayBuffer>();
  for (const entry of header.blobEntries) {
    if (entry.offset < 0 || entry.offset + entry.size > blob.byteLength) {
      return makeErr(
        new DebugError({
          code: 'tape-handle-graph-broken',
          expected: 'blob entry offset+size within binary blob bounds',
          hint: `blob entry '${entry.hash}' has offset=${entry.offset} size=${entry.size} but blob stream has byteLength=${blob.byteLength}`,
          detail: {
            danglingHandleId: entry.hash,
            referencingEventIndex: -1,
          },
        }),
      );
    }
    const bytes = blob.slice(entry.offset, entry.offset + entry.size);
    blobPool.set(entry.hash, bytes.buffer as ArrayBuffer);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const eventArr = events as readonly RhiCallEvent[];

  // m4-2: handle id graph integrity check
  const declaredHandleIds = new Set<HandleId>();
  for (const event of eventArr) {
    collectDeclaredHandleIds(event, declaredHandleIds);
  }

  for (const event of eventArr) {
    const dangling = findDanglingHandleId(event, declaredHandleIds);
    if (dangling !== null) {
      return makeErr(
        new DebugError({
          code: 'tape-handle-graph-broken',
          expected: 'all handleId references refer to a handleId declared by a prior create* event',
          hint: `handleId '${dangling}' is referenced but was never declared by any create* event in the tape. This may be a steady-frame tape captured without prior resource recording; re-capture with the fixed recorder or use a self-contained tape (arm before creating resources).`,
          detail: {
            danglingHandleId: dangling,
            referencingEventIndex: eventArr.indexOf(event),
          },
        }),
      );
    }
  }

  const tape: Tape = {
    formatVersion: header.formatVersion,
    rhiCapsRecorded: header.rhiCapsRecorded,
    events: eventArr,
    blobPool,
  };

  return makeOk(tape);
}

// ============================================================================
// Handle graph validation helpers
// ============================================================================

/**
 * Collect all handleIds declared by create* events.
 *
 * Each create* event creates a new resource (Buffer, Texture, etc.) and
 * assigns a handleId. These handleIds form the "declared" set that must
 * contain all handleIds referenced by later events.
 */
function collectDeclaredHandleIds(event: RhiCallEvent, declared: Set<HandleId>): void {
  switch (event.kind) {
    case 'createBuffer':
    case 'createTexture':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createPipelineLayout':
    case 'createRenderPipeline':
    case 'createComputePipeline':
    case 'createShaderModule':
      declared.add((event as RhiCallEventCreateBuffer).handleId);
      break;
    case 'createBindGroup':
      declared.add((event as RhiCallEventCreateBindGroup).handleId);
      break;
    case 'createTextureView':
      declared.add((event as RhiCallEventCreateTextureView).resultHandleId);
      break;
    case 'createCommandEncoder':
      declared.add((event as RhiCallEventCreateCommandEncoder).cmdHandleId);
      break;
    case 'beginRenderPass':
    case 'beginComputePass':
      declared.add((event as RhiCallEventBeginRenderPass).passHandleId);
      break;
    case 'initialData':
      break;
    default:
      break;
  }
}

/**
 * Find the first handleId reference that is not in the declared set.
 * Returns null if all references are valid.
 */
function findDanglingHandleId(event: RhiCallEvent, declared: Set<HandleId>): HandleId | null {
  switch (event.kind) {
    case 'writeBuffer': {
      const e = event as RhiCallEventWriteBuffer;
      if (!declared.has(e.handleId)) return e.handleId;
      return null;
    }
    case 'writeTexture': {
      const e = event as RhiCallEventWriteTexture;
      if (!declared.has(e.destination.textureHandleId)) return e.destination.textureHandleId;
      return null;
    }
    case 'copyExternalImageToTexture': {
      const e = event as RhiCallEventCopyExternalImageToTexture;
      if (!declared.has(e.destination.textureHandleId)) return e.destination.textureHandleId;
      return null;
    }
    case 'submit': {
      const e = event as RhiCallEventSubmit;
      for (const id of e.cmdHandleIds) {
        if (!declared.has(id)) return id;
      }
      return null;
    }
    case 'beginRenderPass': {
      const e = event as RhiCallEventBeginRenderPass;
      if (!declared.has(e.cmdHandleId)) return e.cmdHandleId;
      if (e.depthStencilViewHandleId !== undefined && !declared.has(e.depthStencilViewHandleId))
        return e.depthStencilViewHandleId;
      for (const id of e.colorAttachmentViewHandleIds) {
        if (id !== undefined && id !== null && !declared.has(id)) return id;
      }
      return null;
    }
    case 'beginComputePass': {
      const e = event as RhiCallEventBeginComputePass;
      if (!declared.has(e.cmdHandleId)) return e.cmdHandleId;
      return null;
    }
    case 'copyBufferToBuffer': {
      const e = event as RhiCallEventCopyBufferToBuffer;
      if (!declared.has(e.sourceHandleId)) return e.sourceHandleId;
      if (!declared.has(e.destinationHandleId)) return e.destinationHandleId;
      return null;
    }
    case 'copyBufferToTexture': {
      const e = event as RhiCallEventCopyBufferToTexture;
      if (!declared.has(e.source.bufferHandleId)) return e.source.bufferHandleId;
      if (!declared.has(e.destination.textureHandleId)) return e.destination.textureHandleId;
      return null;
    }
    case 'copyTextureToBuffer': {
      const e = event as RhiCallEventCopyTextureToBuffer;
      if (!declared.has(e.source.textureHandleId)) return e.source.textureHandleId;
      if (!declared.has(e.destination.bufferHandleId)) return e.destination.bufferHandleId;
      return null;
    }
    case 'copyTextureToTexture': {
      const e = event as RhiCallEventCopyTextureToTexture;
      if (!declared.has(e.source.textureHandleId)) return e.source.textureHandleId;
      if (!declared.has(e.destination.textureHandleId)) return e.destination.textureHandleId;
      return null;
    }
    case 'clearBuffer': {
      const e = event as RhiCallEventClearBuffer;
      if (!declared.has(e.handleId)) return e.handleId;
      return null;
    }
    case 'setPipeline': {
      const e = event as RhiCallEventSetPipeline;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.pipelineHandleId)) return e.pipelineHandleId;
      return null;
    }
    case 'setVertexBuffer': {
      const e = event as RhiCallEventSetVertexBuffer;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.bufferHandleId)) return e.bufferHandleId;
      return null;
    }
    case 'setIndexBuffer': {
      const e = event as RhiCallEventSetIndexBuffer;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.bufferHandleId)) return e.bufferHandleId;
      return null;
    }
    case 'setBindGroup': {
      const e = event as RhiCallEventSetBindGroup;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.bindGroupHandleId)) return e.bindGroupHandleId;
      return null;
    }
    case 'draw': {
      const e = event as RhiCallEventDraw;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'drawIndexed': {
      const e = event as RhiCallEventDrawIndexed;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'setViewport': {
      const e = event as RhiCallEventSetViewport;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'setScissorRect': {
      const e = event as RhiCallEventSetScissorRect;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'endRenderPass': {
      const e = event as RhiCallEventEndRenderPass;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'setComputePipeline': {
      const e = event as RhiCallEventSetComputePipeline;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.pipelineHandleId)) return e.pipelineHandleId;
      return null;
    }
    case 'dispatchWorkgroups': {
      const e = event as RhiCallEventDispatchWorkgroups;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'endComputePass': {
      const e = event as RhiCallEventEndComputePass;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'createBindGroup': {
      const e = event as RhiCallEventCreateBindGroup;
      if (!declared.has(e.layoutHandleId)) return e.layoutHandleId;
      for (const id of e.resourceHandleIds) {
        if (!declared.has(id)) return id;
      }
      return null;
    }
    case 'createPipelineLayout': {
      const e = event as RhiCallEventCreatePipelineLayout;
      for (const id of e.bglHandleIds) {
        if (!declared.has(id)) return id;
      }
      return null;
    }
    case 'createRenderPipeline': {
      const e = event as RhiCallEventCreateRenderPipeline;
      if (e.layoutHandleId !== 'layout:auto' && !declared.has(e.layoutHandleId))
        return e.layoutHandleId;
      return null;
    }
    case 'createComputePipeline': {
      const e = event as RhiCallEventCreateComputePipeline;
      if (e.layoutHandleId !== 'layout:auto' && !declared.has(e.layoutHandleId))
        return e.layoutHandleId;
      return null;
    }
    case 'createTextureView': {
      const e = event as RhiCallEventCreateTextureView;
      if (!declared.has(e.sourceHandleId)) return e.sourceHandleId;
      return null;
    }
    case 'initialData': {
      const e = event as RhiCallEventInitialData;
      if (!declared.has(e.handleId)) return e.handleId;
      return null;
    }
    case 'pushDebugGroup':
    case 'popDebugGroup':
    case 'insertDebugMarker':
    case 'finish': {
      const e = event as RhiCallEventPushDebugGroup;
      if (!declared.has(e.cmdHandleId)) return e.cmdHandleId;
      return null;
    }
    // v3 new event kinds (w7)
    case 'setBlendConstant': {
      type E = { readonly kind: 'setBlendConstant'; readonly passHandleId: string };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'drawIndirect': {
      type E = {
        readonly kind: 'drawIndirect';
        readonly passHandleId: string;
        readonly indirectBufferHandleId: string;
      };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.indirectBufferHandleId)) return e.indirectBufferHandleId;
      return null;
    }
    case 'drawIndexedIndirect': {
      type E = {
        readonly kind: 'drawIndexedIndirect';
        readonly passHandleId: string;
        readonly indirectBufferHandleId: string;
      };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      if (!declared.has(e.indirectBufferHandleId)) return e.indirectBufferHandleId;
      return null;
    }
    case 'passPushDebugGroup': {
      type E = { readonly kind: 'passPushDebugGroup'; readonly passHandleId: string };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'passPopDebugGroup': {
      type E = { readonly kind: 'passPopDebugGroup'; readonly passHandleId: string };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'passInsertDebugMarker': {
      type E = { readonly kind: 'passInsertDebugMarker'; readonly passHandleId: string };
      const e = event as unknown as E;
      if (!declared.has(e.passHandleId)) return e.passHandleId;
      return null;
    }
    case 'frameMark':
    case 'createBuffer':
    case 'createTexture':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createShaderModule':
    case 'createCommandEncoder':
      // These events either declare handles or reference none
      return null;
    default: {
      void (event as never);
      return null;
    }
  }
}

// ============================================================================
// Pass offset computation helper (m4-3)
// ============================================================================

export interface PassOffset {
  readonly passIdx: number;
  readonly startDrawIdx: number;
  readonly endDrawIdx: number;
  readonly kind: 'render' | 'compute';
}

/**
 * Compute pass offsets from events array.
 *
 * Scans events and finds beginRenderPass/endRenderPass and
 * beginComputePass/endComputePass pairs, then counts draw/drawIndexed and
 * dispatchWorkgroups calls within each pass to compute start/end draw indices.
 *
 * `startDrawIdx` is the global draw index of the first draw/dispatch call within this pass.
 * `endDrawIdx` is the global draw index of the last draw/dispatch call within this pass.
 * Empty passes (no draw/dispatch) produce `endDrawIdx < startDrawIdx` (empty range).
 * `kind` discriminates render passes from compute passes.
 */
export function computePassOffsets(events: readonly RhiCallEvent[]): PassOffset[] {
  const offsets: PassOffset[] = [];
  let passIdx = 0;
  let globalDrawIdx = 0;
  let inPass = false;
  let passKind: 'render' | 'compute' = 'render';
  let passStartDrawIdx = -1;
  let passEndDrawIdx = -1;

  for (const event of events) {
    if (event.kind === 'beginRenderPass') {
      inPass = true;
      passKind = 'render';
      passStartDrawIdx = globalDrawIdx;
      passEndDrawIdx = globalDrawIdx - 1;
    } else if (event.kind === 'endRenderPass') {
      if (inPass) {
        offsets.push({
          passIdx,
          startDrawIdx: passStartDrawIdx,
          endDrawIdx: passEndDrawIdx,
          kind: passKind,
        });
        passIdx++;
      }
      inPass = false;
    } else if (event.kind === 'beginComputePass') {
      inPass = true;
      passKind = 'compute';
      passStartDrawIdx = globalDrawIdx;
      passEndDrawIdx = globalDrawIdx - 1;
    } else if (event.kind === 'endComputePass') {
      if (inPass) {
        offsets.push({
          passIdx,
          startDrawIdx: passStartDrawIdx,
          endDrawIdx: passEndDrawIdx,
          kind: passKind,
        });
        passIdx++;
      }
      inPass = false;
    } else if (
      (event.kind === 'draw' ||
        event.kind === 'drawIndexed' ||
        event.kind === 'drawIndirect' ||
        event.kind === 'drawIndexedIndirect' ||
        event.kind === 'dispatchWorkgroups') &&
      inPass
    ) {
      passEndDrawIdx = globalDrawIdx;
      globalDrawIdx++;
    }
  }

  return offsets;
}
