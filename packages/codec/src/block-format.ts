/**
 * Block-compressed texture format parameter table (D-6 shared SSOT).
 *
 * One table maps every WebGPU block-compressed `GPUTextureFormat` to its
 * texel-block dimensions and compressed bytes-per-block. Both the texture
 * upload path and the equirect upload path (M5) derive `bytesPerRow` /
 * `rowsPerImage` from this single table -- block math is defined once
 * (Derive, Don't Duplicate).
 *
 * Format list follows the WebGPU spec "Compressed Texture Formats" section.
 * PVRTC and ASTC-HDR are intentionally absent (OOS-5 / not exposed by WebGPU
 * core). Uncompressed formats are not in the table -- callers branch on
 * `isCompressedFormat` first and handle the linear `width * bytesPerPixel`
 * case themselves.
 */

/** Texel-block dimensions + compressed size for one block-compressed format. */
export interface BlockParams {
  readonly blockW: number;
  readonly blockH: number;
  readonly bytesPerBlock: number;
}

/**
 * Block parameter table for every WebGPU block-compressed format.
 *
 * BC / ETC2 / EAC blocks are all 4x4 texels; ASTC block dimensions are encoded
 * in the format name (`astc-<W>x<H>-...`) and every ASTC block is 16 bytes.
 * bytesPerBlock: 8 for the 0.5-bpp formats (BC1, BC4, ETC2-rgb8, ETC2-rgb8a1,
 * EAC-r11), 16 for the 1-bpp formats (BC2/3/5/6H/7, ETC2-rgba8, EAC-rg11, ASTC).
 */
const BLOCK_TABLE: ReadonlyMap<GPUTextureFormat, BlockParams> = new Map<
  GPUTextureFormat,
  BlockParams
>([
  // -- BC (S3TC / RGTC / BPTC) --
  ['bc1-rgba-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['bc1-rgba-unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['bc2-rgba-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc2-rgba-unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc3-rgba-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc3-rgba-unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc4-r-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['bc4-r-snorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['bc5-rg-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc5-rg-snorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc6h-rgb-ufloat', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc6h-rgb-float', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc7-rgba-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['bc7-rgba-unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],

  // -- ETC2 / EAC --
  ['etc2-rgb8unorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['etc2-rgb8unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['etc2-rgb8a1unorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['etc2-rgb8a1unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['etc2-rgba8unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['etc2-rgba8unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['eac-r11unorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['eac-r11snorm', { blockW: 4, blockH: 4, bytesPerBlock: 8 }],
  ['eac-rg11unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['eac-rg11snorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],

  // -- ASTC (all 16 bytes/block; block dims from the format name) --
  ['astc-4x4-unorm', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['astc-4x4-unorm-srgb', { blockW: 4, blockH: 4, bytesPerBlock: 16 }],
  ['astc-5x4-unorm', { blockW: 5, blockH: 4, bytesPerBlock: 16 }],
  ['astc-5x4-unorm-srgb', { blockW: 5, blockH: 4, bytesPerBlock: 16 }],
  ['astc-5x5-unorm', { blockW: 5, blockH: 5, bytesPerBlock: 16 }],
  ['astc-5x5-unorm-srgb', { blockW: 5, blockH: 5, bytesPerBlock: 16 }],
  ['astc-6x5-unorm', { blockW: 6, blockH: 5, bytesPerBlock: 16 }],
  ['astc-6x5-unorm-srgb', { blockW: 6, blockH: 5, bytesPerBlock: 16 }],
  ['astc-6x6-unorm', { blockW: 6, blockH: 6, bytesPerBlock: 16 }],
  ['astc-6x6-unorm-srgb', { blockW: 6, blockH: 6, bytesPerBlock: 16 }],
  ['astc-8x5-unorm', { blockW: 8, blockH: 5, bytesPerBlock: 16 }],
  ['astc-8x5-unorm-srgb', { blockW: 8, blockH: 5, bytesPerBlock: 16 }],
  ['astc-8x6-unorm', { blockW: 8, blockH: 6, bytesPerBlock: 16 }],
  ['astc-8x6-unorm-srgb', { blockW: 8, blockH: 6, bytesPerBlock: 16 }],
  ['astc-8x8-unorm', { blockW: 8, blockH: 8, bytesPerBlock: 16 }],
  ['astc-8x8-unorm-srgb', { blockW: 8, blockH: 8, bytesPerBlock: 16 }],
  ['astc-10x5-unorm', { blockW: 10, blockH: 5, bytesPerBlock: 16 }],
  ['astc-10x5-unorm-srgb', { blockW: 10, blockH: 5, bytesPerBlock: 16 }],
  ['astc-10x6-unorm', { blockW: 10, blockH: 6, bytesPerBlock: 16 }],
  ['astc-10x6-unorm-srgb', { blockW: 10, blockH: 6, bytesPerBlock: 16 }],
  ['astc-10x8-unorm', { blockW: 10, blockH: 8, bytesPerBlock: 16 }],
  ['astc-10x8-unorm-srgb', { blockW: 10, blockH: 8, bytesPerBlock: 16 }],
  ['astc-10x10-unorm', { blockW: 10, blockH: 10, bytesPerBlock: 16 }],
  ['astc-10x10-unorm-srgb', { blockW: 10, blockH: 10, bytesPerBlock: 16 }],
  ['astc-12x10-unorm', { blockW: 12, blockH: 10, bytesPerBlock: 16 }],
  ['astc-12x10-unorm-srgb', { blockW: 12, blockH: 10, bytesPerBlock: 16 }],
  ['astc-12x12-unorm', { blockW: 12, blockH: 12, bytesPerBlock: 16 }],
  ['astc-12x12-unorm-srgb', { blockW: 12, blockH: 12, bytesPerBlock: 16 }],
]);

/**
 * Look up the block parameters for a format. Returns `null` for uncompressed
 * formats (the table only holds block-compressed entries).
 */
export function blockParamsForFormat(format: GPUTextureFormat): BlockParams | null {
  return BLOCK_TABLE.get(format) ?? null;
}

/** Guard: true iff `format` is a block-compressed format in the table. */
export function isCompressedFormat(format: GPUTextureFormat): boolean {
  return BLOCK_TABLE.has(format);
}

/**
 * Bytes per row for a compressed mip level of the given pixel width:
 * `ceil(width / blockW) * bytesPerBlock`. Tail texels pad up to a full block.
 * Returns `null` for uncompressed formats (no block entry) -- callers branch on
 * `isCompressedFormat` first.
 */
export function bytesPerRow(format: GPUTextureFormat, width: number): number | null {
  const params = BLOCK_TABLE.get(format);
  if (params === undefined) return null;
  return Math.ceil(width / params.blockW) * params.bytesPerBlock;
}

/**
 * Block rows for a compressed mip level of the given pixel height:
 * `ceil(height / blockH)`. Returns `null` for uncompressed formats.
 */
export function rowsPerImage(format: GPUTextureFormat, height: number): number | null {
  const params = BLOCK_TABLE.get(format);
  if (params === undefined) return null;
  return Math.ceil(height / params.blockH);
}
