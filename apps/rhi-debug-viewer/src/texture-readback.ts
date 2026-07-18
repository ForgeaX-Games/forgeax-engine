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
import type { CreateShaderModuleFn, RhiCallEvent } from '@forgeax/engine-rhi-debug';
import { readbackTexturePixels, resolveTextureDescriptor } from '@forgeax/engine-rhi-debug';
import { blitDepthToR32 } from './depth-blit';

/** True for any depth/depth-stencil format (all contain the 'depth' token). */
export function isDepthFormat(format: string): boolean {
  return format.includes('depth');
}

// depth24plus* depth plane is NOT copyable via copyTextureToBuffer (driver-private
// layout); its real values are read by sampling into an r32float RT (blitDepthToR32).
// All other depth formats (depth32float / depth16unorm / *-stencil8 whose depth is
// depth32float) read back directly. This set is the SSOT for that branch.
const NON_COPYABLE_DEPTH = new Set(['depth24plus', 'depth24plus-stencil8']);

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
 * @param baseArrayLayer - Array layer (slice) to read; 0 for a plain 2D texture.
 * @returns Raw depth32float values as Float32Array (tight, no row padding).
 */
export async function readbackDepthTexture(
  device: RhiDevice,
  depthTexture: unknown,
  texWidth: number,
  texHeight: number,
  baseArrayLayer = 0,
): Promise<Float32Array> {
  const bytes = await readbackTexturePixels(device, depthTexture, texWidth, texHeight, {
    bytesPerTexel: 4,
    baseArrayLayer,
  });

  // Reinterpret the Uint8Array as Float32Array (little-endian per KB)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Read back a depth texture's raw depth values as a tight Float32Array, choosing
 * the faithful path by format: depth24plus* (depth plane not copyable) is sampled
 * into an r32float RT via the blit; every other depth format reads back directly.
 *
 * This is the SSOT for "live depth texture -> Float32 depth values" — both the
 * depth-stencil attachment path and the bound-depth-texture path call it, so the
 * copyable-vs-blit decision lives in exactly one place.
 *
 * @param device - The RHI device that owns the depth texture.
 * @param createShaderModuleFn - Standalone shader compiler (needed only for the blit).
 * @param depthTexture - The live depth GPU texture (opaque handle).
 * @param format - The texture's real format (selects blit vs direct readback).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 * @param baseArrayLayer - Array layer (slice) to read; 0 for a plain 2D texture,
 *   `layer*6 + face` for a cube/cube-array shadow atlas.
 * @returns Raw depth values as Float32Array (tight, no row padding).
 */
export async function readbackDepthAuto(
  device: RhiDevice,
  createShaderModuleFn: CreateShaderModuleFn,
  depthTexture: unknown,
  format: string,
  texWidth: number,
  texHeight: number,
  baseArrayLayer = 0,
): Promise<Float32Array> {
  return NON_COPYABLE_DEPTH.has(format)
    ? blitDepthToR32(
        device,
        createShaderModuleFn,
        depthTexture,
        texWidth,
        texHeight,
        baseArrayLayer,
      )
    : readbackDepthTexture(device, depthTexture, texWidth, texHeight, baseArrayLayer);
}

/**
 * Read back a depth-stencil texture's STENCIL plane (uint8) as a tight Uint8Array.
 *
 * Unlike the depth plane of depth24plus*, the stencil8 plane IS copyable via
 * copyTextureToBuffer(aspect:'stencil-only') on every format that has one — so
 * this is a direct readback, no blit pass needed.
 *
 * @param device - The RHI device that owns the texture.
 * @param stencilTexture - The combined depth-stencil GPU texture (opaque handle).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 * @returns Raw stencil values as Uint8Array (tight, one byte per texel).
 */
export async function readbackStencilTexture(
  device: RhiDevice,
  stencilTexture: unknown,
  texWidth: number,
  texHeight: number,
): Promise<Uint8Array> {
  return readbackTexturePixels(device, stencilTexture, texWidth, texHeight, {
    bytesPerTexel: 1,
    aspect: 'stencil-only',
  });
}

/**
 * Resolve the depth-stencil texture descriptor from a tape's events.
 *
 * Thin wrapper over the package's {@link resolveTextureDescriptor} SSOT (which
 * walks createTextureView resultHandleId -> sourceHandleId -> createTexture);
 * kept here as the depth-attachment-named entry point. Returns null if the
 * attachment is undefined or has no matching createTexture event.
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
  return resolveTextureDescriptor(events, depthStencilViewHandleId);
}
