// @forgeax/engine-rhi-debug/src/readback — shared GPU texture→host readback utilities.
//
// Extracted from inspector.ts (round 1 fix-up 34be40d6, I-7) for reuse by
// replayer.readbackRt() (m5b-1) and e2e.dawn.test.ts (m5b-3).
//
// Related: plan-strategy §5.3.1; m5b-1 / m5b-3.

/// <reference types="@webgpu/types" />

import type {
  Buffer,
  MappedBuffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiQueue,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from './errors';
import type { RhiCallEvent } from './types';

// GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9.
const COPY_DST_MAP_READ = 9;
const TEXTURE_READBACK_USAGE = COPY_DST_MAP_READ;

// ============================================================================
// resolveTextureDescriptor — tape handle -> source texture descriptor (SSOT)
// ============================================================================

/** Resolved descriptor for a texture (or texture-view) handle from the tape. */
export interface ResolvedTextureDescriptor {
  /** The source GPUTexture handleId (copyTextureToBuffer needs a texture, not a view). */
  readonly handleId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  /** The view's dimension ('2d' | 'cube' | '2d-array' | '3d' | ...); '2d' when no view event. */
  readonly dimension: string;
  /** The source texture's depthOrArrayLayers (slice count); 1 for a plain 2D texture. */
  readonly arrayLayers: number;
}

/**
 * Walk the tape events to resolve a view-or-texture handleId to its source
 * GPUTexture descriptor (handleId, real dimensions, format, view dimension).
 *
 * The single source of truth for "tape handle -> texture descriptor": both the
 * color-attachment RT path (resolveAttachmentSize / readbackDrawRt) and the
 * viewer's depth + bound-texture preview paths resolve handles this way —
 * createTextureView.resultHandleId -> sourceHandleId -> createTexture, falling
 * back to the id itself when it is a direct texture handle (no view event).
 *
 * Size is read from the raw createTexture event. Returns null when no
 * createTexture event declares the resolved handle.
 */
export function resolveTextureDescriptor(
  events: readonly RhiCallEvent[],
  viewOrTextureHandleId: string,
): ResolvedTextureDescriptor | null {
  // Step 1: resolve texture view -> source texture handleId + capture view dimension.
  let sourceTextureHandleId: string | undefined;
  let viewDimension: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === viewOrTextureHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      viewDimension = ev.desc.dimension;
      break;
    }
  }
  // Some handles are texture handles directly (no view event).
  const targetHandleId = sourceTextureHandleId ?? viewOrTextureHandleId;

  // Step 2: find the createTexture event for the resolved texture handleId.
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === targetHandleId) {
      const sz = ev.desc.size;
      let width: number;
      let height: number;
      let arrayLayers: number;
      // GPUExtent3DStrict: { width, height?, depthOrArrayLayers? } or [w, h?, d?]
      if (Array.isArray(sz)) {
        width = typeof sz[0] === 'number' ? sz[0] : 512;
        height = typeof sz[1] === 'number' ? sz[1] : width;
        arrayLayers = typeof sz[2] === 'number' ? sz[2] : 1;
      } else {
        const obj = sz as { width: number; height?: number; depthOrArrayLayers?: number };
        width = typeof obj.width === 'number' ? obj.width : 512;
        height = typeof obj.height === 'number' ? obj.height : width;
        arrayLayers = typeof obj.depthOrArrayLayers === 'number' ? obj.depthOrArrayLayers : 1;
      }
      return {
        handleId: targetHandleId,
        width,
        height,
        format: ev.desc.format,
        // View dimension wins; else the texture's own dimension; else '2d'.
        dimension: viewDimension ?? ev.desc.dimension ?? '2d',
        arrayLayers,
      };
    }
  }

  return null;
}

// ============================================================================
// resolveAttachmentSize — walk tape events to find texture dimensions
// ============================================================================

/**
 * Walk the tape events to find the real texture dimensions for a given
 * color attachment view/target handleId. Avoids hard-coding 512×512.
 *
 * Thin wrapper over {@link resolveTextureDescriptor}; returns
 * { width: 512, height: 512 } as a conservative fallback when no createTexture
 * event is found (should not happen for a real frame).
 */
export function resolveAttachmentSize(
  events: readonly RhiCallEvent[],
  attachmentViewHandleId: string,
): { readonly width: number; readonly height: number } {
  const desc = resolveTextureDescriptor(events, attachmentViewHandleId);
  if (desc === null) return { width: 512, height: 512 };
  return { width: desc.width, height: desc.height };
}

// ============================================================================
// readbackTexturePixels — copyTextureToBuffer + mapAsync + getMappedRange
// ============================================================================

/**
 * Read back raw RGBA8 pixels from a GPU texture into a host-side Uint8Array.
 *
 * Steps:
 * 1. Create a staging buffer (COPY_DST | MAP_READ) sized to aligned rows.
 * 2. Create a command encoder + copyTextureToBuffer.
 * 3. Finish + submit + await onSubmittedWorkDone.
 * 4. mapAsync(READ) + getMappedRange() → new Uint8Array(slice).
 * 5. Unmap + destroy staging buffer.
 *
 * The returned Uint8Array has length = texWidth * texHeight * 4 (tight;
 * alignment padding is stripped). The buffer alignment is WebGPU 256-byte
 * row requirement.
 *
 * @param device - The RHI device that owns the texture.
 * @param texture - The texture to read back (opaque branded handle at the boundary).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 */
export async function readbackTexturePixels(
  device: RhiDevice,
  texture: unknown,
  texWidth: number,
  texHeight: number,
  opts?: {
    /** Bytes in one uncompressed texel; retained for depth/color callers. */
    bytesPerTexel?: number;
    /** Compressed-format footprint; defaults to bytesPerTexel with a 1x1 block. */
    bytesPerBlock?: number;
    blockWidth?: number;
    blockHeight?: number;
    mipLevel?: number;
    baseArrayLayer?: number;
    aspect?: 'all' | 'depth-only' | 'stencil-only';
  },
): Promise<Uint8Array> {
  const bytesPerBlock = opts?.bytesPerBlock ?? opts?.bytesPerTexel ?? 4;
  const blockWidth = opts?.blockWidth ?? 1;
  const blockHeight = opts?.blockHeight ?? 1;
  const blockCountX = Math.ceil(texWidth / blockWidth);
  const blockCountY = Math.ceil(texHeight / blockHeight);
  const copyWidth = blockCountX * blockWidth;
  const copyHeight = blockCountY * blockHeight;
  const mipLevel = opts?.mipLevel ?? 0;
  const baseArrayLayer = opts?.baseArrayLayer ?? 0;
  const aspect = opts?.aspect;
  const rowBytes = blockCountX * bytesPerBlock;
  const alignedRowBytes = Math.ceil(rowBytes / 256) * 256; // WebGPU alignment
  const bufferSize = alignedRowBytes * blockCountY;

  const readbackBufferResult = device.createBuffer({
    size: bufferSize,
    usage: COPY_DST_MAP_READ,
  });
  if (!readbackBufferResult.ok) {
    throw new Error(`createBuffer for readback failed: ${readbackBufferResult.error.code}`);
  }
  const readbackBuffer = readbackBufferResult.value;

  const encoderResult = device.createCommandEncoder({});
  if (!encoderResult.ok) {
    device.destroyBuffer(readbackBuffer);
    throw new Error(`createCommandEncoder for readback failed: ${encoderResult.error.code}`);
  }
  const encoder = encoderResult.value;

  try {
    encoder.copyTextureToBuffer(
      {
        texture,
        mipLevel,
        origin: { x: 0, y: 0, z: baseArrayLayer },
        // aspect selects depth vs stencil plane on combined depth-stencil
        // textures. stencil-only IS copyable on depth24plus-stencil8 (the
        // depth plane is not). Omitted -> backend default ('all').
        ...(aspect !== undefined ? { aspect } : {}),
      } as unknown as never,
      {
        buffer: readbackBuffer,
        offset: 0,
        bytesPerRow: alignedRowBytes,
        rowsPerImage: blockCountY,
      } as unknown as never,
      { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
    );
  } catch {
    device.destroyBuffer(readbackBuffer);
    throw new Error('copyTextureToBuffer failed');
  }

  const finishResult = encoder.finish();
  if (!finishResult.ok) {
    device.destroyBuffer(readbackBuffer);
    throw new Error(`encoder.finish failed: ${finishResult.error.code}`);
  }

  const queue: RhiQueue = device.queue;
  queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
  await queue.onSubmittedWorkDone();

  // RHI Buffer.mapAsync / MappedBuffer.getMappedRange return Result wrappers, not
  // the raw spec void / ArrayBuffer. The previous `as unknown as { ... }` casts
  // hid that: mapAsync was called with mode=2 (which is GPUMapMode.WRITE, not
  // READ=0x1) and getMappedRange's Result object was fed straight into
  // `new Uint8Array(...)`, yielding a zero-length array — every RT readback came
  // back all-zero (transparent black), which the e2e delta check missed because
  // baseline and replay were equally empty (empty-vs-empty trap).
  const buffer = readbackBuffer as unknown as Buffer;
  // GPUMapMode.READ = 0x1
  const mapResult = await buffer.mapAsync(0x1);
  if (!mapResult.ok) {
    device.destroyBuffer(readbackBuffer);
    throw new Error(`mapAsync(READ) failed: ${mapResult.error.code}`);
  }
  const mapped: MappedBuffer = mapResult.value;

  const rangeResult = mapped.getMappedRange();
  if (!rangeResult.ok) {
    mapped.unmap();
    device.destroyBuffer(readbackBuffer);
    throw new Error(`getMappedRange failed: ${rangeResult.error.code}`);
  }
  const fullPixels = new Uint8Array(rangeResult.value);

  // Extract tight pixels (strip alignment padding)
  const tightPixels = new Uint8Array(blockCountX * blockCountY * bytesPerBlock);
  for (let y = 0; y < blockCountY; y++) {
    const srcOffset = y * alignedRowBytes;
    const dstOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      tightPixels[dstOffset + x] = fullPixels[srcOffset + x] ?? 0;
    }
  }

  // Cleanup
  mapped.unmap();
  device.destroyBuffer(readbackBuffer);

  return tightPixels;
}

// ============================================================================
// readbackBufferBytes — copyBufferToBuffer + mapAsync + getMappedRange (D-7)
// ============================================================================

/**
 * Read back the raw bytes of a GPU buffer into a host-side ArrayBuffer.
 *
 * Sibling of readbackTexturePixels under the single "GPU byte readback"
 * responsibility unit (plan-strategy D-7) — snapshotResource calls this to
 * capture a buffer's initial GPU bytes at frame-header time.
 *
 * Steps:
 * 1. Create a staging buffer (COPY_DST | MAP_READ) sized to `size`.
 * 2. Create a command encoder + copyBufferToBuffer(src, 0, staging, 0, size).
 * 3. Finish + submit + await onSubmittedWorkDone.
 * 4. mapAsync(READ=0x1) + getMappedRange() -> sliced ArrayBuffer copy.
 * 5. Unmap + destroy staging buffer.
 *
 * Returns Ok(ArrayBuffer) (a detached copy independent of the mapped range)
 * or Err(readback-failed) with `.detail.phase` narrowing
 * the failure point (copy / map). The buffer is passed opaque (`unknown`)
 * because RHI handles are branded; the caller resolved it from the descriptor
 * registry. The caller (snapshotResource) holds the handleId and maps this
 * readback error to the capture-snapshot-failed boundary.
 *
 * Reuses the M0-fixed mapAsync(0x1) + Result-unwrap pattern from
 * readbackTexturePixels (never the all-zero mode=2 bug).
 *
 * @param device - The RHI device that owns the buffer.
 * @param buffer - The source buffer (opaque branded handle) to read back.
 * @param size - Number of bytes to read back (the buffer's recorded size).
 */
export async function readbackBufferBytes(
  device: RhiDevice,
  buffer: unknown,
  size: number,
): Promise<Result<ArrayBuffer, RhiDebugError>> {
  const fail = (phase: 'copy' | 'map', cause: string): Result<ArrayBuffer, RhiDebugError> =>
    err(createRhiDebugError('readback-failed', { stage: 'readback', phase, cause }));

  const readbackBufferResult = device.createBuffer({ size, usage: COPY_DST_MAP_READ });
  if (!readbackBufferResult.ok) {
    return fail('copy', `staging buffer creation failed: ${readbackBufferResult.error.code}`);
  }
  const readbackBuffer = readbackBufferResult.value;

  const encoderResult = device.createCommandEncoder({});
  if (!encoderResult.ok) {
    device.destroyBuffer(readbackBuffer);
    return fail('copy', `command encoder creation failed: ${encoderResult.error.code}`);
  }
  const encoder = encoderResult.value;

  try {
    encoder.copyBufferToBuffer(buffer as Buffer, 0, readbackBuffer, 0, size);
  } catch (e) {
    device.destroyBuffer(readbackBuffer);
    return fail('copy', `copyBufferToBuffer failed: ${String(e)}`);
  }

  const finishResult = encoder.finish();
  if (!finishResult.ok) {
    device.destroyBuffer(readbackBuffer);
    return fail('copy', `encoder.finish failed: ${finishResult.error.code}`);
  }

  const queue: RhiQueue = device.queue;
  queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
  await queue.onSubmittedWorkDone();

  const stagingBuffer = readbackBuffer as unknown as Buffer;
  // GPUMapMode.READ = 0x1
  const mapResult = await stagingBuffer.mapAsync(0x1);
  if (!mapResult.ok) {
    device.destroyBuffer(readbackBuffer);
    return fail('map', `mapAsync(READ) failed: ${mapResult.error.code}`);
  }
  const mapped: MappedBuffer = mapResult.value;

  const rangeResult = mapped.getMappedRange();
  if (!rangeResult.ok) {
    mapped.unmap();
    device.destroyBuffer(readbackBuffer);
    return fail('map', `getMappedRange failed: ${rangeResult.error.code}`);
  }

  // Copy the mapped bytes into a standalone ArrayBuffer before unmap — the
  // mapped range is invalidated on unmap.
  const bytes = new Uint8Array(rangeResult.value).slice();

  mapped.unmap();
  device.destroyBuffer(readbackBuffer);

  return ok(bytes.buffer as ArrayBuffer);
}

/** A load-time buffer that can be read back as part of one GPU submission. */
export interface BufferReadbackBatchRequest {
  readonly handleId: string;
  readonly buffer: unknown;
  readonly size: number;
}

export interface BufferReadbackBatchCallbacks {
  readonly onResourceStart?: (handleId: string) => void;
  readonly onResourceComplete?: (handleId: string) => void;
  /** Return true when the owning snapshot generation has been invalidated. */
  readonly isCancelled?: () => boolean;
}

async function raceCancellation<T>(
  work: Promise<T>,
  isCancelled: (() => boolean) | undefined,
): Promise<{ readonly cancelled: true } | { readonly cancelled: false; readonly value: T }> {
  if (isCancelled === undefined) return { cancelled: false, value: await work };
  if (isCancelled()) return { cancelled: true };

  let timer: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<{ readonly cancelled: true }>((resolve) => {
    timer = setInterval(() => {
      if (isCancelled()) resolve({ cancelled: true });
    }, 1);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ cancelled: false as const, value })),
      cancelled,
    ]);
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/**
 * Read back multiple buffers with one command submission and one queue drain.
 *
 * Prism City exposed the cost of the old one-buffer helper: every resource
 * submitted and awaited independently, so thousands of small buffers spent
 * most of capture time in synchronization rather than byte transfer. The
 * batch keeps each staging buffer isolated but submits all copies together;
 * mapping remains per-resource so a timeout can still identify the current
 * handle and the caller can preserve the original initialData event order.
 */
export async function readbackBufferBytesBatch(
  device: RhiDevice,
  requests: readonly BufferReadbackBatchRequest[],
  callbacks: BufferReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugError>> {
  if (requests.length === 0) return ok(new Map());
  const firstRequest = requests[0];
  if (firstRequest === undefined) return ok(new Map());

  const fail = (handleId: string, phase: 'copy' | 'map', cause: string) =>
    err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        phase,
        cause: `${handleId}: ${cause}`,
      }),
    );
  const staging: Array<{ readonly request: BufferReadbackBatchRequest; readonly buffer: Buffer }> =
    [];
  const mapped = new Map<Buffer, MappedBuffer>();
  const cleaned = new Set<Buffer>();
  const cleanup = () => {
    for (const mappedBuffer of mapped.values()) mappedBuffer.unmap();
    for (const item of staging) {
      if (!cleaned.has(item.buffer)) {
        device.destroyBuffer(item.buffer);
        cleaned.add(item.buffer);
      }
    }
  };

  let encoder: RhiCommandEncoder;
  try {
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return fail(
        firstRequest.handleId,
        'copy',
        `command encoder creation failed: ${encoderResult.error.code}`,
      );
    encoder = encoderResult.value;
    for (const request of requests) {
      const stagingResult = device.createBuffer({ size: request.size, usage: COPY_DST_MAP_READ });
      if (!stagingResult.ok) {
        cleanup();
        return fail(
          request.handleId,
          'copy',
          `staging buffer creation failed: ${stagingResult.error.code}`,
        );
      }
      const stagingBuffer = stagingResult.value;
      staging.push({ request, buffer: stagingBuffer });
      try {
        encoder.copyBufferToBuffer(request.buffer as Buffer, 0, stagingBuffer, 0, request.size);
      } catch (error) {
        cleanup();
        return fail(request.handleId, 'copy', `copyBufferToBuffer failed: ${String(error)}`);
      }
    }
    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'copy',
        `encoder.finish failed: ${finishResult.error.code}`,
      );
    }
    device.queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
    await device.queue.onSubmittedWorkDone();

    // Start every mapAsync together. The GPU work has already been submitted
    // and drained; awaiting each map before starting the next one recreates a
    // per-resource synchronization wall even after batching the copies.
    const mapResultsPromise = Promise.all(
      staging.map(async (item) => {
        callbacks.onResourceStart?.(item.request.handleId);
        try {
          const result = await item.buffer.mapAsync(0x1);
          if (result.ok) {
            if (callbacks.isCancelled?.()) result.value.unmap();
            else mapped.set(item.buffer, result.value);
          }
          return { item, result };
        } catch (error) {
          return { item, error };
        }
      }),
    );
    const mapResults = await raceCancellation(mapResultsPromise, callbacks.isCancelled);
    if (mapResults.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'buffer batch readback cancelled after the snapshot generation was invalidated',
      );
    }
    const result = new Map<string, ArrayBuffer>();
    for (const mappedResult of mapResults.value) {
      if ('error' in mappedResult) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${String(mappedResult.error)}`,
        );
      }
      if (!mappedResult.result.ok) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${mappedResult.result.error.code}`,
        );
      }
      const mappedBuffer = mappedResult.result.value;
      const item = mappedResult.item;
      const rangeResult = mappedBuffer.getMappedRange();
      if (!rangeResult.ok) {
        cleanup();
        return fail(
          item.request.handleId,
          'map',
          `getMappedRange failed: ${rangeResult.error.code}`,
        );
      }
      result.set(
        item.request.handleId,
        new Uint8Array(rangeResult.value).slice().buffer as ArrayBuffer,
      );
      mappedBuffer.unmap();
      mapped.delete(item.buffer);
      device.destroyBuffer(item.buffer);
      cleaned.add(item.buffer);
      callbacks.onResourceComplete?.(item.request.handleId);
    }
    return ok(result);
  } catch (error) {
    cleanup();
    return fail(firstRequest.handleId, 'map', `buffer batch readback failed: ${String(error)}`);
  }
}

/** One (layer, mip) copy contributing to a complete texture snapshot blob. */
export interface TextureReadbackBatchSlice {
  readonly layer: number;
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** A complete texture whose subresources are copied in one bounded batch. */
export interface TextureReadbackBatchRequest {
  readonly handleId: string;
  readonly texture: unknown;
  readonly bytesPerBlock: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly totalBytes: number;
  readonly slices: readonly TextureReadbackBatchSlice[];
}

export interface TextureReadbackBatchCallbacks {
  readonly onResourceStart?: (handleId: string) => void;
  readonly onResourceComplete?: (handleId: string) => void;
  /** Return true when the owning snapshot generation has been invalidated. */
  readonly isCancelled?: () => boolean;
}

/**
 * Read complete texture snapshots with one submission and drain per bounded
 * resource batch. Each subresource retains its own staging buffer, so mip and
 * array-layer bytes are copied without padding or ordering loss.
 */
export async function readbackTexturePixelsBatch(
  device: RhiDevice,
  requests: readonly TextureReadbackBatchRequest[],
  callbacks: TextureReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugError>> {
  if (requests.length === 0) return ok(new Map());
  const firstRequest = requests[0];
  if (firstRequest === undefined) return ok(new Map());

  const fail = (handleId: string, phase: 'copy' | 'map', cause: string) =>
    err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        phase,
        cause: `${handleId}: ${cause}`,
      }),
    );
  const staging: Array<{
    readonly request: TextureReadbackBatchRequest;
    readonly slice: TextureReadbackBatchSlice;
    readonly buffer: Buffer;
    readonly bytesPerBlock: number;
    readonly blockWidth: number;
    readonly blockHeight: number;
  }> = [];
  const mapped = new Map<Buffer, MappedBuffer>();
  const cleaned = new Set<Buffer>();
  const cleanup = () => {
    for (const mappedBuffer of mapped.values()) mappedBuffer.unmap();
    for (const item of staging) {
      if (!cleaned.has(item.buffer)) {
        device.destroyBuffer(item.buffer);
        cleaned.add(item.buffer);
      }
    }
  };

  let encoder: RhiCommandEncoder;
  try {
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return fail(
        firstRequest.handleId,
        'copy',
        `command encoder creation failed: ${encoderResult.error.code}`,
      );
    encoder = encoderResult.value;
    for (const request of requests) {
      for (const slice of request.slices) {
        const blockCountX = Math.ceil(slice.width / request.blockWidth);
        const blockCountY = Math.ceil(slice.height / request.blockHeight);
        const rowBytes = blockCountX * request.bytesPerBlock;
        const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
        const stagingResult = device.createBuffer({
          size: alignedRowBytes * blockCountY,
          usage: TEXTURE_READBACK_USAGE,
        });
        if (!stagingResult.ok) {
          cleanup();
          return fail(
            request.handleId,
            'copy',
            `staging buffer creation failed: ${stagingResult.error.code}`,
          );
        }
        const stagingBuffer = stagingResult.value;
        staging.push({
          request,
          slice,
          buffer: stagingBuffer,
          bytesPerBlock: request.bytesPerBlock,
          blockWidth: request.blockWidth,
          blockHeight: request.blockHeight,
        });
        try {
          encoder.copyTextureToBuffer(
            {
              texture: request.texture,
              mipLevel: slice.mip,
              origin: { x: 0, y: 0, z: slice.layer },
            } as unknown as never,
            {
              buffer: stagingBuffer,
              offset: 0,
              bytesPerRow: alignedRowBytes,
              rowsPerImage: blockCountY,
            } as unknown as never,
            {
              width: blockCountX * request.blockWidth,
              height: blockCountY * request.blockHeight,
              depthOrArrayLayers: 1,
            },
          );
        } catch (error) {
          cleanup();
          return fail(request.handleId, 'copy', `copyTextureToBuffer failed: ${String(error)}`);
        }
      }
    }
    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'copy',
        `encoder.finish failed: ${finishResult.error.code}`,
      );
    }
    device.queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
    const drain = raceCancellation(device.queue.onSubmittedWorkDone(), callbacks.isCancelled);
    const drainResult = await drain;
    if (drainResult.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'texture batch readback cancelled after the snapshot generation was invalidated',
      );
    }

    for (const request of requests) callbacks.onResourceStart?.(request.handleId);
    const mapResultsPromise = Promise.all(
      staging.map(async (item) => {
        try {
          const result = await item.buffer.mapAsync(0x1);
          if (result.ok) {
            if (callbacks.isCancelled?.()) result.value.unmap();
            else mapped.set(item.buffer, result.value);
          }
          return { item, result };
        } catch (error) {
          return { item, error };
        }
      }),
    );
    const mapResults = await raceCancellation(mapResultsPromise, callbacks.isCancelled);
    if (mapResults.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'texture batch readback cancelled after the snapshot generation was invalidated',
      );
    }

    const bytesByHandle = new Map<string, Uint8Array>();
    for (const request of requests)
      bytesByHandle.set(request.handleId, new Uint8Array(request.totalBytes));
    for (const mappedResult of mapResults.value) {
      if ('error' in mappedResult) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${String(mappedResult.error)}`,
        );
      }
      if (!mappedResult.result.ok) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${mappedResult.result.error.code}`,
        );
      }
      const item = mappedResult.item;
      const mappedBuffer = mappedResult.result.value;
      const rangeResult = mappedBuffer.getMappedRange();
      if (!rangeResult.ok) {
        cleanup();
        return fail(
          item.request.handleId,
          'map',
          `getMappedRange failed: ${rangeResult.error.code}`,
        );
      }
      const fullBytes = new Uint8Array(rangeResult.value);
      const blockCountX = Math.ceil(item.slice.width / item.blockWidth);
      const blockCountY = Math.ceil(item.slice.height / item.blockHeight);
      const rowBytes = blockCountX * item.bytesPerBlock;
      const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
      const output = bytesByHandle.get(item.request.handleId);
      if (output === undefined) {
        cleanup();
        return fail(item.request.handleId, 'map', 'texture batch returned an unknown handle');
      }
      for (let y = 0; y < blockCountY; y++) {
        const srcOffset = y * alignedRowBytes;
        const dstOffset = item.slice.byteOffset + y * rowBytes;
        for (let x = 0; x < rowBytes; x++) output[dstOffset + x] = fullBytes[srcOffset + x] ?? 0;
      }
      mappedBuffer.unmap();
      mapped.delete(item.buffer);
      device.destroyBuffer(item.buffer);
      cleaned.add(item.buffer);
    }
    const result = new Map<string, ArrayBuffer>();
    for (const request of requests) {
      const bytes = bytesByHandle.get(request.handleId);
      if (bytes === undefined) {
        cleanup();
        return fail(request.handleId, 'map', 'texture batch returned no bytes for a live texture');
      }
      result.set(request.handleId, bytes.buffer as ArrayBuffer);
      callbacks.onResourceComplete?.(request.handleId);
    }
    return ok(result);
  } catch (error) {
    cleanup();
    return fail(firstRequest.handleId, 'map', `texture batch readback failed: ${String(error)}`);
  }
}
