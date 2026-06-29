// @forgeax/engine-rhi-debug/src/rt-to-canvas — node-free RT-to-canvas render (L3c).
//
// Exports renderRtToCanvas(replay, drawIdx, device, canvas) which reads back
// the color attachment pixels at a specific drawIdx and renders them onto an
// external canvas via ImageData + putImageData. No node: imports, no pngjs,
// no inspector.ts — tree-shake safe for browser consumption.
//
// Constraints:
//   D-2: reuses readbackDrawRt (SSOT GPU readback, per-draw path B).
//   D-3: zero node: / pngjs / inspector.ts imports.
//   D-4: reuses `rt-readback-failed` error code (no new DebugErrorCode).
//   D-7: ImageData primary path, createImageBitmap optional.
//   AC-06: accepts HTMLCanvasElement | OffscreenCanvas.
//   AC-07: internal use of readbackDrawRt verified via grep.
//   AC-08: zero node: imports.
//
// Related: requirements AC-06/AC-07/AC-08; plan-strategy D-2/D-3/D-4/D-7.

/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { readbackDrawRt } from './readback';
import type { Replay } from './replayer';

// ============================================================================
// renderRtToCanvas
// ============================================================================

/**
 * Read back the color attachment RT at a specific drawIdx and render it onto
 * an external canvas element via ImageData + putImageData.
 *
 * Reuses `readbackDrawRt` (SSOT per-draw GPU readback, D-2) and renders the
 * RGBA8 pixels onto the canvas using a 2d rendering context. The canvas must
 * be sized to at least the RT dimensions before calling — `putImageData`
 * places the image at (0,0) and throws if the image extends beyond the canvas
 * bounds.
 *
 * Supports both `HTMLCanvasElement` (main-thread DOM) and `OffscreenCanvas`
 * (Worker context) — both expose `getContext('2d')` and `putImageData`.
 *
 * Edge cases:
 *   - **No color attachment** at the target drawIdx (e.g. compute-only pass
 *     or empty tape): returns `err(DebugError)` with code `'rt-readback-failed'`
 *     — reuses the existing readback error code (D-4).
 *   - **readbackDrawRt failure** (GPU readback error, handle resolution
 *     failure, etc.): returns `err` with the same error transparently (AC-13
 *     no wrapping).
 *
 * @param replay - The already-constructed Replay session.
 * @param drawIdx - The global draw event index to read back (0-based).
 * @param device - The RhiDevice for GPU readback.
 * @param canvas - The target canvas (DOM or Worker OffscreenCanvas).
 * @returns Ok(void) on success or Err(DebugError) on readback failure.
 */
export async function renderRtToCanvas(
  replay: Replay,
  drawIdx: number,
  device: RhiDevice,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Result<void, DebugError>> {
  // Read back RT pixels via the shared SSOT readback (D-2).
  const readbackRes = await readbackDrawRt(replay, drawIdx, device);
  if (!readbackRes.ok) {
    return err(readbackRes.error);
  }
  const { width, height, pixels } = readbackRes.value;

  // Create ImageData from the readback pixels.
  // Copy into a fresh Uint8ClampedArray so the backing buffer is ArrayBuffer
  // (ImageData rejects SharedArrayBuffer backings from shared-memory types).
  const clamped = new Uint8ClampedArray(pixels);
  const imageData = new ImageData(clamped, width, height);

  // Render onto the canvas via 2d context.
  // Both HTMLCanvasElement and OffscreenCanvas expose getContext('2d').
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'canvas to support a 2d rendering context',
        hint: 'getContext("2d") returned null; the canvas may be detached or unsupported',
      }),
    );
  }
  ctx.putImageData(imageData, 0, 0);

  return ok(undefined);
}
