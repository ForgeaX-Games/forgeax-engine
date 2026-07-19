// buffer-content.ts — buffer content readback and typed-view decoding (w9).
//
// F3 buffer content readback:
//   1. Prefer tape blobPool direct read (zero-GPU) — lookup via
//      initialData/writeBuffer events: handleId → dataHash → blobPool.
//   2. Live GPU readback (readbackBufferBytes) as fallback for buffers
//      with COPY_SRC usage.
//   3. Explicit "not readable" annotation for mappable staging buffers
//      (MAP_READ | COPY_SRC is illegal per WebGPU spec).
//   4. Typed view decoding: f32 / u32 / i32 / u8.
//   5. Truncation: buffers > 100KB show first 256 items + total count.
//
// Related: requirements AC-07; plan-strategy D-7; research Finding 1.

import type { Tape } from '@forgeax/engine-rhi-debug';
import type { CreateDescriptor } from './viewer-model';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Byte threshold for truncation: buffers larger than this show truncated view. */
export const BUFFER_TRUNCATE_BYTES = 100 * 1024; // 100 KB

/** Max items to display when truncated. */
export const BUFFER_MAX_ITEMS = 256;

/**
 * GPUBufferUsage flags.
 * pnpm-lint: direct literals avoid GPUBufferUsage crash in jsdom tests.
 */
const MAP_READ = 0x0001;
const MAP_WRITE = 0x0002;
const COPY_SRC = 0x0004;

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------

export type BufferContentSource =
  | { kind: 'blobPool'; hashHint: string }
  | { kind: 'liveReadback' }
  | { kind: 'notReadable'; reason: string };

/**
 * Determine the content source for a buffer resource.
 *
 * Priority:
 *   1. blobPool — check tape events for initialData/writeBuffer matching handleId.
 *   2. liveReadback — buffer has COPY_SRC usage (GPU readback available).
 *   3. notReadable — mappable staging buffer (MAP_READ|MAP_WRITE without COPY_SRC),
 *      or buffer with neither blob data nor COPY_SRC.
 */
export function getBufferContentSource(
  tape: Tape,
  handleId: string,
  resources: ReadonlyMap<string, CreateDescriptor>,
): BufferContentSource {
  // 1. Check blobPool via initialData events
  for (const event of tape.events) {
    if (event.kind === 'initialData' && event.handleId === handleId) {
      if (tape.blobPool.has(event.dataHash)) {
        return { kind: 'blobPool', hashHint: event.dataHash };
      }
    }
  }

  // 2. Check blobPool via writeBuffer events
  for (const event of tape.events) {
    if (event.kind === 'writeBuffer' && event.handleId === handleId) {
      if (tape.blobPool.has(event.dataHash)) {
        return { kind: 'blobPool', hashHint: event.dataHash };
      }
    }
  }

  // 3. No blobPool data — check usage for live-readback eligibility
  const resource = resources.get(handleId);
  if (!resource || resource.kind !== 'createBuffer') {
    return { kind: 'notReadable', reason: 'buffer not found in resources' };
  }

  const usage = resource.usage;
  const isMappable = (usage & MAP_READ) !== 0 || (usage & MAP_WRITE) !== 0;
  const hasCopySrc = (usage & COPY_SRC) !== 0;

  if (isMappable && !hasCopySrc) {
    return {
      kind: 'notReadable',
      reason: 'not readable: mappable staging buffer (no COPY_SRC)',
    };
  }

  if (hasCopySrc) {
    return { kind: 'liveReadback' };
  }

  return {
    kind: 'notReadable',
    reason: 'not readable: no initial data, no COPY_SRC usage',
  };
}

// ---------------------------------------------------------------------------
// BlobPool data extraction
// ---------------------------------------------------------------------------

/**
 * Extract the raw ArrayBuffer for a buffer handleId from the tape's blobPool.
 *
 * Looks for initialData events first (full buffer snapshot at recording start),
 * then writeBuffer events (runtime writes).
 *
 * Returns null if no blob data found for this handleId.
 */
export function getBufferBlobData(tape: Tape, handleId: string): ArrayBuffer | null {
  // Check initialData events first — full buffer snapshot
  for (const event of tape.events) {
    if (event.kind === 'initialData' && event.handleId === handleId) {
      const blob = tape.blobPool.get(event.dataHash);
      if (blob) return blob;
    }
  }

  // Fallback to writeBuffer events
  for (const event of tape.events) {
    if (event.kind === 'writeBuffer' && event.handleId === handleId) {
      const blob = tape.blobPool.get(event.dataHash);
      if (blob) return blob;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Typed view decoding
// ---------------------------------------------------------------------------

export type BufferViewType = 'f32' | 'u32' | 'i32' | 'u8';

/** Byte size per element for each view type. */
export const VIEW_BYTE_SIZE: Record<BufferViewType, number> = {
  f32: 4,
  u32: 4,
  i32: 4,
  u8: 1,
};

/**
 * Decode a single element from an ArrayBuffer at the given byte offset.
 */
export function decodeViewElement(
  data: ArrayBuffer,
  byteOffset: number,
  viewType: BufferViewType,
): number {
  const dv = new DataView(data);
  // Guard against out-of-bounds
  if (byteOffset + VIEW_BYTE_SIZE[viewType] > data.byteLength) {
    return NaN;
  }
  switch (viewType) {
    case 'f32':
      return dv.getFloat32(byteOffset, true);
    case 'u32':
      return dv.getUint32(byteOffset, true);
    case 'i32':
      return dv.getInt32(byteOffset, true);
    case 'u8':
      return dv.getUint8(byteOffset);
  }
}

/**
 * Decode a range of elements from an ArrayBuffer.
 */
export function decodeViewRange(
  data: ArrayBuffer,
  byteOffset: number,
  count: number,
  viewType: BufferViewType,
): number[] {
  const result: number[] = [];
  const step = VIEW_BYTE_SIZE[viewType];
  const maxByte = data.byteLength;
  for (let i = 0; i < count; i++) {
    const off = byteOffset + i * step;
    if (off + step > maxByte) break;
    result.push(decodeViewElement(data, off, viewType));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Formatted display helpers
// ---------------------------------------------------------------------------

/**
 * Format a decoded value for display.
 * u8: hex (0xNN); f32: 6 significant digits; integers: decimal.
 */
export function formatViewValue(value: number, viewType: BufferViewType): string {
  if (Number.isNaN(value)) return '—';
  switch (viewType) {
    case 'u8':
      return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`;
    case 'f32': {
      // Avoid exponential notation for common ranges
      if (value === 0) return '0.0';
      if (Math.abs(value) < 1e-6) return value.toExponential(4);
      if (Math.abs(value) > 1e6) return value.toExponential(4);
      return value.toPrecision(6);
    }
    case 'u32':
      return value.toString();
    case 'i32':
      return value.toString();
  }
}

/**
 * Build a display summary for buffer content.
 *
 * Returns an object with the decoded items and metadata.
 */
export interface BufferContentDisplay {
  readonly items: number[];
  readonly viewType: BufferViewType;
  readonly totalItems: number;
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export function buildBufferContentDisplay(
  data: ArrayBuffer,
  viewType: BufferViewType,
): BufferContentDisplay {
  const step = VIEW_BYTE_SIZE[viewType];
  const totalItems = Math.floor(data.byteLength / step);
  const truncated = data.byteLength > BUFFER_TRUNCATE_BYTES && totalItems > BUFFER_MAX_ITEMS;

  const displayCount = truncated ? BUFFER_MAX_ITEMS : totalItems;
  const items = decodeViewRange(data, 0, displayCount, viewType);

  return {
    items,
    viewType,
    totalItems,
    truncated,
    totalBytes: data.byteLength,
  };
}
