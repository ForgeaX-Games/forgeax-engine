import {
  blockParamsForFormat,
  bytesPerRow,
  isCompressedFormat,
  rowsPerImage,
} from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

/**
 * block-format lookup + byte-ratio unit tests (w9).
 *
 * AC-17 VRAM ratio: block-compressed TextureAsset.data (tight-packed, mip 0
 * only here) is >=4x smaller than same-size RGBA8 for BC7/ASTC-4x4 (both 16
 * bytes / 16 texels = 1 bpp block vs 4 bpp RGBA8 => 4x), and >=8x for
 * ETC1S->BC1/ETC1 (8 bytes / 16 texels = 0.5 bpp => 8x).
 *
 * AC-08 non-4-multiple sizes: bytesPerRow = ceil(width/blockW) * bytesPerBlock,
 * rowsPerImage = ceil(height/blockH). Tail blocks (1x1 / 2x2 mip) pad up to a
 * full block.
 *
 * The block table is the shared SSOT (D-6) consumed by both the texture upload
 * path and the equirect upload path.
 */

describe('blockParamsForFormat — compressed format dimensions (w9)', () => {
  it('bc7-rgba-unorm => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('bc7-rgba-unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('bc7-rgba-unorm-srgb => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('bc7-rgba-unorm-srgb')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('bc1-rgba-unorm => 4x4 block, 8 bytes', () => {
    expect(blockParamsForFormat('bc1-rgba-unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 8,
    });
  });

  it('bc4-r-unorm => 4x4 block, 8 bytes', () => {
    expect(blockParamsForFormat('bc4-r-unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 8,
    });
  });

  it('bc5-rg-unorm => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('bc5-rg-unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('bc6h-rgb-ufloat => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('bc6h-rgb-ufloat')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('etc2-rgba8unorm => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('etc2-rgba8unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('etc2-rgb8unorm => 4x4 block, 8 bytes', () => {
    expect(blockParamsForFormat('etc2-rgb8unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 8,
    });
  });

  it('eac-r11unorm => 4x4 block, 8 bytes', () => {
    expect(blockParamsForFormat('eac-r11unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 8,
    });
  });

  it('eac-rg11unorm => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('eac-rg11unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('astc-4x4-unorm => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('astc-4x4-unorm')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('astc-4x4-unorm-srgb => 4x4 block, 16 bytes', () => {
    expect(blockParamsForFormat('astc-4x4-unorm-srgb')).toEqual({
      blockW: 4,
      blockH: 4,
      bytesPerBlock: 16,
    });
  });

  it('uncompressed format (rgba8unorm) returns null block params', () => {
    expect(blockParamsForFormat('rgba8unorm')).toBeNull();
  });

  it('uncompressed HDR format (rgba16float) returns null block params', () => {
    expect(blockParamsForFormat('rgba16float')).toBeNull();
  });
});

describe('isCompressedFormat — guard (w9)', () => {
  it('true for block-compressed formats', () => {
    expect(isCompressedFormat('bc7-rgba-unorm')).toBe(true);
    expect(isCompressedFormat('bc1-rgba-unorm')).toBe(true);
    expect(isCompressedFormat('etc2-rgba8unorm')).toBe(true);
    expect(isCompressedFormat('astc-4x4-unorm-srgb')).toBe(true);
    expect(isCompressedFormat('bc6h-rgb-ufloat')).toBe(true);
    expect(isCompressedFormat('eac-rg11unorm')).toBe(true);
  });

  it('false for uncompressed formats', () => {
    expect(isCompressedFormat('rgba8unorm')).toBe(false);
    expect(isCompressedFormat('rgba8unorm-srgb')).toBe(false);
    expect(isCompressedFormat('rgba16float')).toBe(false);
    expect(isCompressedFormat('r8unorm')).toBe(false);
    expect(isCompressedFormat('rg8unorm')).toBe(false);
  });
});

describe('bytesPerRow / rowsPerImage — ceil logic (w9)', () => {
  it('BC7 64x64: 16 blocks/row * 16 bytes = 256 bytes/row, 16 rows', () => {
    expect(bytesPerRow('bc7-rgba-unorm', 64)).toBe(256);
    expect(rowsPerImage('bc7-rgba-unorm', 64)).toBe(16);
  });

  it('BC7 65x65 (non-4-multiple): ceil(65/4)=17 blocks => 272 bytes/row, 17 rows', () => {
    expect(bytesPerRow('bc7-rgba-unorm', 65)).toBe(17 * 16);
    expect(rowsPerImage('bc7-rgba-unorm', 65)).toBe(17);
  });

  it('BC1 63x63: ceil(63/4)=16 blocks => 128 bytes/row, 16 rows', () => {
    expect(bytesPerRow('bc1-rgba-unorm', 63)).toBe(16 * 8);
    expect(rowsPerImage('bc1-rgba-unorm', 63)).toBe(16);
  });

  it('BC7 1x1 mip tail block pads to a full 4x4 block', () => {
    expect(bytesPerRow('bc7-rgba-unorm', 1)).toBe(16);
    expect(rowsPerImage('bc7-rgba-unorm', 1)).toBe(1);
  });

  it('BC7 2x2 mip tail block pads to a full 4x4 block', () => {
    expect(bytesPerRow('bc7-rgba-unorm', 2)).toBe(16);
    expect(rowsPerImage('bc7-rgba-unorm', 2)).toBe(1);
  });

  it('bytesPerRow throws / returns 0 semantics documented for uncompressed via null', () => {
    // uncompressed formats have no block table entry; callers must branch on
    // isCompressedFormat first. bytesPerRow returns null for these.
    expect(bytesPerRow('rgba8unorm', 64)).toBeNull();
    expect(rowsPerImage('rgba8unorm', 64)).toBeNull();
  });
});

describe('byte-ratio assertions vs RGBA8 tight-pack (AC-17, w9)', () => {
  function rgba8Bytes(w: number, h: number): number {
    return w * h * 4;
  }

  function compressedBytes(format: GPUTextureFormat, w: number, h: number): number {
    const bpr = bytesPerRow(format, w);
    const rows = rowsPerImage(format, h);
    if (bpr === null || rows === null) throw new Error(`no block params for ${format}`);
    return bpr * rows;
  }

  it('BC7 256x256 is >=4x smaller than RGBA8 tight-pack', () => {
    const ratio = rgba8Bytes(256, 256) / compressedBytes('bc7-rgba-unorm', 256, 256);
    expect(ratio).toBeGreaterThanOrEqual(4);
  });

  it('ASTC-4x4 256x256 is >=4x smaller than RGBA8 tight-pack', () => {
    const ratio = rgba8Bytes(256, 256) / compressedBytes('astc-4x4-unorm', 256, 256);
    expect(ratio).toBeGreaterThanOrEqual(4);
  });

  it('BC1 (ETC1S->BC1 delivery) 256x256 is >=8x smaller than RGBA8 tight-pack', () => {
    const ratio = rgba8Bytes(256, 256) / compressedBytes('bc1-rgba-unorm', 256, 256);
    expect(ratio).toBeGreaterThanOrEqual(8);
  });

  it('ETC2-rgb8 (ETC1->RGB delivery) 256x256 is >=8x smaller than RGBA8 tight-pack', () => {
    const ratio = rgba8Bytes(256, 256) / compressedBytes('etc2-rgb8unorm', 256, 256);
    expect(ratio).toBeGreaterThanOrEqual(8);
  });
});
