// @forgeax/engine-rhi-debug/src/readback — shared GPU texture→host readback utilities.
//
// Extracted from inspector.ts (round 1 fix-up 34be40d6, I-7) for reuse by
// replayer.readbackRt() (m5b-1) and e2e.dawn.test.ts (m5b-3).
//
// Related: plan-strategy §5.3.1; m5b-1 / m5b-3.

/// <reference types="@webgpu/types" />

import type { Buffer, MappedBuffer, RhiDevice, RhiQueue } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { extractDrawInfo } from './inspect-core';
import type { Replay } from './replayer';
import type { RhiCallEvent } from './types';

// ============================================================================
// resolveAttachmentSize — walk tape events to find texture dimensions
// ============================================================================

/**
 * Walk the tape events to find the real texture dimensions for a given
 * color attachment view/target handleId. Avoids hard-coding 512×512.
 *
 * Returns { width: 512, height: 512 } as a conservative fallback when no
 * createTexture event is found (should not happen for a real frame).
 */
export function resolveAttachmentSize(
  events: readonly RhiCallEvent[],
  attachmentViewHandleId: string,
): { readonly width: number; readonly height: number } {
  // Find the createTextureView whose resultHandleId matches.
  let sourceTextureHandleId: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === attachmentViewHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      break;
    }
  }
  // Some attachments are texture handles directly (no view event).
  const targetHandleId = sourceTextureHandleId ?? attachmentViewHandleId;

  // Find the createTexture event for the resolved texture handleId.
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === targetHandleId) {
      const sz = ev.desc.size;
      // GPUExtent3DStrict: { width, height? } or [w, h?, d?]
      if (Array.isArray(sz)) {
        const w = typeof sz[0] === 'number' ? sz[0] : 512;
        const h = typeof sz[1] === 'number' ? sz[1] : w;
        return { width: w, height: h };
      }
      const obj = sz as { width: number; height?: number };
      const w = typeof obj.width === 'number' ? obj.width : 512;
      const h = typeof obj.height === 'number' ? obj.height : w;
      return { width: w, height: h };
    }
  }

  return { width: 512, height: 512 };
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
 * @param texture - The texture to read back (opaque branded handle cast as any).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 */
export async function readbackTexturePixels(
  device: RhiDevice,
  texture: unknown,
  texWidth: number,
  texHeight: number,
  opts?: { bytesPerTexel?: number; mipLevel?: number; baseArrayLayer?: number },
): Promise<Uint8Array> {
  const bytesPerPixel = opts?.bytesPerTexel ?? 4;
  const mipLevel = opts?.mipLevel ?? 0;
  const baseArrayLayer = opts?.baseArrayLayer ?? 0;
  const rowBytes = texWidth * bytesPerPixel;
  const alignedRowBytes = Math.ceil(rowBytes / 256) * 256; // WebGPU alignment
  const bufferSize = alignedRowBytes * texHeight;

  // GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9
  const COPY_DST_MAP_READ = 9;

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
      } as unknown as never,
      {
        buffer: readbackBuffer,
        offset: 0,
        bytesPerRow: alignedRowBytes,
        rowsPerImage: texHeight,
      } as unknown as never,
      { width: texWidth, height: texHeight, depthOrArrayLayers: 1 },
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
  const tightPixels = new Uint8Array(texWidth * texHeight * bytesPerPixel);
  for (let y = 0; y < texHeight; y++) {
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
 * or Err(DebugError snapshot-readback-failed) with `.detail.stage` narrowing
 * the failure point (copy / map). The buffer is passed opaque (`unknown`)
 * because RHI handles are branded; the caller resolved it from the descriptor
 * registry. `.detail.handleId` is left empty here — the caller (snapshotResource)
 * holds the handleId and re-stamps it on the failure path.
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
): Promise<Result<ArrayBuffer, DebugError>> {
  const fail = (stage: 'copy' | 'map', hint: string): Result<ArrayBuffer, DebugError> =>
    err(
      new DebugError({
        code: 'snapshot-readback-failed',
        expected: 'buffer GPU byte readback to succeed',
        hint,
        detail: { handleId: '', stage },
      }),
    );

  // GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9
  const COPY_DST_MAP_READ = 9;

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

// ============================================================================
// readbackDrawRt — node-free GPU readback for a specific drawIdx (D-2/D-5)
// ============================================================================

/**
 * Read back the color attachment RT pixels for a specific draw call within
 * a replay session.
 *
 * Moved from inspector.ts:530-622 (readbackAndEncodePng segment). Anchors
 * on the target drawIdx color attachment (path B per-draw), not the last
 * beginRenderPass (path A). Returns raw {width, height, pixels} — both
 * rt-to-canvas (L3c) and inspector PNG encode (M2) consume this shape.
 *
 * Steps:
 * 1. Access replay._events and validate.
 * 2. Call extractDrawInfo to get colorAttachmentHandleId at drawIdx.
 * 3. Walk createTextureView events (view->source texture backtracking)
 *    to resolve the GPUTexture handleId from the view handleId.
 * 4. Resolve the texture via replay._resolveHandle.
 * 5. resolveAttachmentSize for w/h.
 * 6. readbackTexturePixels for pixel data.
 *
 * @param replay - The Replay session.
 * @param drawIdx - The draw call index to read back.
 * @param device - The RhiDevice for GPU readback.
 * @returns Ok({width, height, pixels}) or Err(DebugError) on failure.
 */
export async function readbackDrawRt(
  replay: Replay,
  drawIdx: number,
  device: RhiDevice,
): Promise<
  Result<
    { readonly width: number; readonly height: number; readonly pixels: Uint8Array },
    DebugError
  >
> {
  // Access the replay's internal events for draw info extraction.
  const events = (replay as unknown as { _events: readonly RhiCallEvent[] })._events as
    | readonly RhiCallEvent[]
    | undefined;
  if (events === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'replay to expose internal _events for RT readback',
        hint: 'the Replay implementation must provide _events accessor for the inspector',
      }),
    );
  }

  // Find the color attachment texture handle at drawIdx
  const drawInfo = extractDrawInfo(events, drawIdx);
  if (drawInfo.colorAttachmentHandleId === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'a color attachment exists at the given drawIdx',
        hint: `no color attachment found at drawIdx ${drawIdx}; the draw may be in a compute pass or the tape may have no render pass`,
      }),
    );
  }

  // Resolve the texture handle from the replay
  const resolveHandle = (replay as unknown as { _resolveHandle(id: string): unknown })
    ._resolveHandle;
  if (typeof resolveHandle !== 'function') {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'replay to expose _resolveHandle method for RT readback',
        hint: 'the Replay implementation must provide _resolveHandle accessor for the inspector',
      }),
    );
  }

  // colorAttachmentHandleId is the textureVIEW handle. copyTextureToBuffer
  // needs the source GPUTexture, so walk back the createTextureView event
  // to its sourceHandleId.
  let sourceTextureHandleId: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === drawInfo.colorAttachmentHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      break;
    }
  }
  const textureHandleId = sourceTextureHandleId ?? drawInfo.colorAttachmentHandleId;

  const texture = resolveHandle(textureHandleId);
  // biome-ignore lint/suspicious/noExplicitAny: texture is an opaque branded type from RHI
  const tex = texture as any;
  if (tex === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'color attachment texture was recreated by replay',
        hint: `handleId '${textureHandleId}' (from view '${drawInfo.colorAttachmentHandleId}') not found in replay handle map`,
      }),
    );
  }

  // Resolve real texture dimensions from tape events
  const texSize = resolveAttachmentSize(events, drawInfo.colorAttachmentHandleId);
  const texWidth = texSize.width;
  const texHeight = texSize.height;

  // Read back tight-packed RGBA8 pixels from the GPU texture
  let pixels: Uint8Array;
  try {
    pixels = await readbackTexturePixels(device, tex, texWidth, texHeight);
  } catch (e) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'readbackTexturePixels to succeed',
        hint: `GPU readback failed: ${String(e)}`,
      }),
    );
  }

  return ok({ width: texWidth, height: texHeight, pixels });
}
