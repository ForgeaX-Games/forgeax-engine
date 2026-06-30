/// <reference types="@webgpu/types" />
// @forgeax/engine-rhi-debug/texel-layout -- SSOT for how a color texture's GPU
// bytes are laid out, shared by the snapshot readback (recorder) and the seed
// write-back (replayer) so both agree on byte layout without duplicating it in
// the tape (architecture-principles #1 SSOT / #2 Derive: format + size +
// mipLevelCount already live in the createTexture event; layout is derived, not
// re-stored in the initialData event).
//
// Why this exists: the original frame-header snapshot hardcoded bytesPerRow =
// width*4, depthOrArrayLayers = 1, mipLevel = 0 -- correct only for a single-mip
// single-layer 4-byte texture (rgba8). IBL resources break all three: the
// irradiance/prefilter cubemaps are rgba16float (8 B/texel), 6 array layers, and
// the prefilter map has a 5-mip roughness chain. Snapshotting them with the old
// assumptions either skipped them (-> replay renders unlit/black) or would have
// seeded corrupt bytes. This module computes the real per-subresource layout so a
// full snapshot + faithful seed round-trips any uncompressed color format.

/**
 * Bytes per texel for uncompressed color formats the snapshot path can
 * round-trip. `undefined` => not snapshottable here: depth/stencil (writeTexture
 * rejects), block-compressed (bc/etc/astc -- texel != byte-addressable), or any
 * format not in this table. Callers treat `undefined` as "skip this texture".
 */
export function bytesPerTexel(format: GPUTextureFormat | undefined): number | undefined {
  if (format === undefined) return undefined;
  return TEXEL_BYTES[format];
}

// Uncompressed color formats only. Keyed to the W3C WebGPU GPUTextureFormat
// names. Depth/stencil and block-compressed formats are deliberately absent
// (their bytes are not a simple width*bytesPerTexel row layout).
const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  // 8-bit channels
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  // 16-bit channels
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  // 32-bit channels
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16,
  // packed
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
};

// ============================================================================
// formatInfo -- per-channel semantics for CPU-side decode (viewer preview)
// ============================================================================

/** How a channel's bits are interpreted (drives the host-side decode-to-RGBA8). */
export type ChannelType = 'unorm' | 'snorm' | 'uint' | 'sint' | 'float' | 'ufloat';

/**
 * Per-channel layout of an uncompressed color format, enough to decode its raw
 * GPU bytes into displayable RGBA8 on the host (no GPU). Sits beside
 * {@link bytesPerTexel} (which stays the SSOT for total texel size); the
 * per-channel byte width is derived as `bytesPerTexel / channels` for plain
 * formats, so no byte count is re-stored here. `packed` formats pack all
 * channels into a single 4-byte word (channels read by bit-field, not by a
 * uniform per-channel width).
 */
export interface FormatInfo {
  readonly channels: 1 | 2 | 3 | 4;
  readonly channelType: ChannelType;
  /** Channels stored blue-first in memory (swizzle B<->R when decoding). */
  readonly bgra?: boolean;
  /** Bit-packed layout (channels share one 32-bit word) needing special unpack. */
  readonly packed?: 'rgb10a2unorm' | 'rg11b10ufloat';
}

// Keyed to the same uncompressed color formats as TEXEL_BYTES. Depth/stencil and
// block-compressed formats are absent (return undefined -> caller falls back).
const FORMAT_INFO: Partial<Record<GPUTextureFormat, FormatInfo>> = {
  // 8-bit channels
  r8unorm: { channels: 1, channelType: 'unorm' },
  r8snorm: { channels: 1, channelType: 'snorm' },
  r8uint: { channels: 1, channelType: 'uint' },
  r8sint: { channels: 1, channelType: 'sint' },
  rg8unorm: { channels: 2, channelType: 'unorm' },
  rg8snorm: { channels: 2, channelType: 'snorm' },
  rg8uint: { channels: 2, channelType: 'uint' },
  rg8sint: { channels: 2, channelType: 'sint' },
  rgba8unorm: { channels: 4, channelType: 'unorm' },
  'rgba8unorm-srgb': { channels: 4, channelType: 'unorm' },
  rgba8snorm: { channels: 4, channelType: 'snorm' },
  rgba8uint: { channels: 4, channelType: 'uint' },
  rgba8sint: { channels: 4, channelType: 'sint' },
  bgra8unorm: { channels: 4, channelType: 'unorm', bgra: true },
  'bgra8unorm-srgb': { channels: 4, channelType: 'unorm', bgra: true },
  // 16-bit channels
  r16uint: { channels: 1, channelType: 'uint' },
  r16sint: { channels: 1, channelType: 'sint' },
  r16float: { channels: 1, channelType: 'float' },
  rg16uint: { channels: 2, channelType: 'uint' },
  rg16sint: { channels: 2, channelType: 'sint' },
  rg16float: { channels: 2, channelType: 'float' },
  rgba16uint: { channels: 4, channelType: 'uint' },
  rgba16sint: { channels: 4, channelType: 'sint' },
  rgba16float: { channels: 4, channelType: 'float' },
  // 32-bit channels
  r32uint: { channels: 1, channelType: 'uint' },
  r32sint: { channels: 1, channelType: 'sint' },
  r32float: { channels: 1, channelType: 'float' },
  rg32uint: { channels: 2, channelType: 'uint' },
  rg32sint: { channels: 2, channelType: 'sint' },
  rg32float: { channels: 2, channelType: 'float' },
  rgba32uint: { channels: 4, channelType: 'uint' },
  rgba32sint: { channels: 4, channelType: 'sint' },
  rgba32float: { channels: 4, channelType: 'float' },
  // packed (channels share one 32-bit word; decoded by bit-field)
  rgb10a2unorm: { channels: 4, channelType: 'unorm', packed: 'rgb10a2unorm' },
  rg11b10ufloat: { channels: 3, channelType: 'ufloat', packed: 'rg11b10ufloat' },
};

/**
 * Per-channel layout of an uncompressed color format for host-side decode.
 * Returns `undefined` for depth/stencil, block-compressed, or unknown formats
 * (the viewer's preview path treats `undefined` as "not directly previewable").
 */
export function formatInfo(format: GPUTextureFormat | string | undefined): FormatInfo | undefined {
  if (format === undefined) return undefined;
  return FORMAT_INFO[format as GPUTextureFormat];
}

/** One mip level of one array layer: its extent + where its tight bytes live in the blob. */
export interface SubresourceSlice {
  readonly layer: number;
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** Full subresource layout of a texture snapshot blob. */
export interface TextureLayout {
  readonly bytesPerTexel: number;
  readonly layerCount: number;
  readonly mipLevelCount: number;
  readonly slices: readonly SubresourceSlice[];
  /** Total tight byte length across every subresource (the blob size). */
  readonly totalBytes: number;
}

/**
 * Compute the canonical tight byte layout for a texture snapshot: every array
 * layer, every mip level, packed in layer-major then mip-minor order with no row
 * padding (tight bytesPerRow = mipWidth * bytesPerTexel). Mip dimensions halve
 * per level (floor, min 1), matching the WebGPU mip size rule.
 *
 * Returns `undefined` when the format has no entry in `bytesPerTexel` (caller
 * skips the texture). The recorder reads each slice into this exact offset; the
 * replayer reads each slice back out and writeTexture's it to (layer, mip).
 */
export function computeTextureLayout(
  format: GPUTextureFormat | undefined,
  width: number,
  height: number,
  layerCount: number,
  mipLevelCount: number,
): TextureLayout | undefined {
  const bpt = bytesPerTexel(format);
  if (bpt === undefined) return undefined;

  const layers = Math.max(1, layerCount);
  const mips = Math.max(1, mipLevelCount);
  const slices: SubresourceSlice[] = [];
  let offset = 0;
  for (let layer = 0; layer < layers; layer++) {
    for (let mip = 0; mip < mips; mip++) {
      const mw = Math.max(1, width >> mip);
      const mh = Math.max(1, height >> mip);
      const byteLength = mw * mh * bpt;
      slices.push({ layer, mip, width: mw, height: mh, byteOffset: offset, byteLength });
      offset += byteLength;
    }
  }
  return {
    bytesPerTexel: bpt,
    layerCount: layers,
    mipLevelCount: mips,
    slices,
    totalBytes: offset,
  };
}
