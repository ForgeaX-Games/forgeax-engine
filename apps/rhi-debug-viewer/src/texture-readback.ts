// texture-readback.ts — depth texture readback with Float32 reinterpretation.
//
// Wraps @forgeax/engine-rhi-debug's readbackTexturePixels with bytesPerTexel=4
// for depth32float textures and reinterprets the returned Uint8Array as
// Float32Array (little-endian, no byteswap needed per KB g2).
//
// Usage: in TextureViewer, when a depth-stencil attachment is selected,
// call readbackDepthTexture(device, depthTexture, width, height) to get
// the raw depth Float32Array for normalizeDepth() visualization.
//
// Related: plan-strategy D-4; research Finding 9; KB webgpu-texel-copy.

/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import type { RhiCallEvent } from '@forgeax/engine-rhi-debug';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';

/**
 * Read back a depth32float texture's raw pixels and reinterpret as Float32Array.
 *
 * The GPU depth buffer is read via copyTextureToBuffer -> mapAsync.
 * The returned Float32Array contains the raw depth values (no normalization).
 * Caller should pass through normalizeDepth() for grayscale visualization.
 *
 * @param device - The RHI device that owns the depth texture.
 * @param depthTexture - The GPU depth texture handle (opaque).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 * @returns Raw depth32float values as Float32Array (tight, no row padding).
 */
export async function readbackDepthTexture(
  device: RhiDevice,
  depthTexture: unknown,
  texWidth: number,
  texHeight: number,
): Promise<Float32Array> {
  const bytes = await readbackTexturePixels(device, depthTexture, texWidth, texHeight, {
    bytesPerTexel: 4,
  });

  // Reinterpret the Uint8Array as Float32Array (little-endian per KB)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Resolve the depth-stencil texture descriptor from a tape's events.
 *
 * Walks the tape events: createTextureView resultHandleId -> sourceHandleId,
 * then finds the corresponding createTexture to extract dimensions and format.
 * Returns null if the depth-stencil attachment has no matching createTexture event.
 *
 * @param events - The tape events array.
 * @param depthStencilViewHandleId - From beginRenderPass.depthStencilViewHandleId.
 * @returns The texture descriptor or null if not found.
 */
export function resolveDepthTextureDescriptor(
  events: readonly RhiCallEvent[],
  depthStencilViewHandleId: string | undefined,
): {
  readonly handleId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
} | null {
  if (depthStencilViewHandleId === undefined) return null;

  // Step 1: resolve texture view -> source texture handleId
  let sourceHandleId: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === depthStencilViewHandleId) {
      sourceHandleId = ev.sourceHandleId;
      break;
    }
  }
  const textureHandleId = sourceHandleId ?? depthStencilViewHandleId;

  // Step 2: find createTexture event
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === textureHandleId) {
      const sz = ev.desc.size;
      let width: number;
      let height: number;
      if (Array.isArray(sz)) {
        width = typeof sz[0] === 'number' ? sz[0] : 512;
        height = typeof sz[1] === 'number' ? sz[1] : width;
      } else {
        const obj = sz as { width: number; height?: number };
        width = typeof obj.width === 'number' ? obj.width : 512;
        height = typeof obj.height === 'number' ? obj.height : width;
      }
      return {
        handleId: textureHandleId,
        width,
        height,
        format: ev.desc.format,
      };
    }
  }

  return null;
}
