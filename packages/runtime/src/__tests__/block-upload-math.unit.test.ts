// w29 -- block-aware upload math unit tests (AC-08).
//
// Table-driven coverage of `deriveMipUploadLayout` (render-data.ts, landed by
// w35): the per-mip GPU-upload layout for block-compressed textures. Each mip
// level's `bytesPerRow` pads the pixel width up to a full block
// (`ceil(width / blockW) * bytesPerBlock`) and `rowsPerImage` counts block rows
// (`ceil(height / blockH)`); `byteOffset` accumulates the prior levels' byte
// lengths (mip-major layout). The GPU samples only the valid texel region, so
// non-4-multiple sizes and the 1x1 / 2x2 mip tails pad up to a block without
// corrupting the image (t5).
//
// This is TDD-RED before w35 -- `deriveMipUploadLayout` does not exist yet.
//
// Constraints (plan-tasks w29):
//   - no real GPU writeTexture call (browser e2e AC-15 owns that)
//   - no re-test of the block table contents (codec w9 owns that)
//   - pure node unit, no browser / dawn dependency

import { describe, expect, it } from 'vitest';
import { deriveMipUploadLayout, deriveTextureExtent, type MipUploadLevel } from '../render-data';

/** Sum of every level's byte length -- the total block-byte buffer size. */
function totalBytes(layout: readonly MipUploadLevel[]): number {
  return layout.reduce((acc, l) => acc + l.byteLength, 0);
}

describe('deriveMipUploadLayout -- single-level block sizing (w29)', () => {
  // BC7 = 4x4 block, 16 bytes/block. bytesPerRow = ceil(w/4)*16.
  it.each([
    // [width, height, expectedBytesPerRow, expectedRowsPerImage]
    [4, 4, 16, 1], // exact single block
    [8, 8, 32, 2], // 2x2 blocks
    [7, 7, 32, 2], // non-4-multiple: ceil(7/4)=2 both axes
    [1, 1, 16, 1], // 1x1 tail pads to a full block
    [2, 2, 16, 1], // 2x2 tail pads to a full block
    [5, 3, 32, 1], // ceil(5/4)=2 -> 32 wide, ceil(3/4)=1 tall
    [16, 1, 64, 1], // wide sliver
  ])('bc7 %ix%i -> bytesPerRow=%i rowsPerImage=%i', (w, h, bpr, rpi) => {
    const layout = deriveMipUploadLayout('bc7-rgba-unorm', w, h, 1);
    expect(layout).toHaveLength(1);
    const l = layout[0] as MipUploadLevel;
    expect(l.level).toBe(0);
    expect(l.width).toBe(w);
    expect(l.height).toBe(h);
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
    expect(l.byteOffset).toBe(0);
    expect(l.byteLength).toBe(bpr * rpi);
  });

  // BC1 / BC4 / ETC2-rgb8 / EAC-r11 = 4x4 block, 8 bytes/block (0.5 bpp).
  it.each([
    ['bc1-rgba-unorm', 8, 8, 16, 2],
    ['bc4-r-unorm', 4, 4, 8, 1],
    ['etc2-rgb8unorm', 16, 16, 32, 4],
    ['eac-r11unorm', 7, 5, 16, 2],
  ] as const)('%s %ix%i -> bytesPerRow=%i rowsPerImage=%i', (fmt, w, h, bpr, rpi) => {
    const l = deriveMipUploadLayout(fmt, w, h, 1)[0] as MipUploadLevel;
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
  });

  // ASTC block dims come from the format name; all 16 bytes/block.
  it.each([
    ['astc-4x4-unorm', 8, 8, 32, 2],
    ['astc-6x6-unorm', 12, 12, 32, 2], // ceil(12/6)=2 -> 32, ceil(12/6)=2
    ['astc-8x8-unorm', 9, 9, 32, 2], // ceil(9/8)=2 both axes
    ['astc-5x4-unorm', 5, 4, 16, 1], // one 5-wide x 4-tall block
  ] as const)('%s %ix%i -> bytesPerRow=%i rowsPerImage=%i', (fmt, w, h, bpr, rpi) => {
    const l = deriveMipUploadLayout(fmt, w, h, 1)[0] as MipUploadLevel;
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
  });

  // BC6H (HDR) = 4x4 block, 16 bytes/block -- the equirect HDR upload path.
  it('bc6h-rgb-ufloat 4x4 -> one 16-byte block', () => {
    const l = deriveMipUploadLayout('bc6h-rgb-ufloat', 4, 4, 1)[0] as MipUploadLevel;
    expect(l.bytesPerRow).toBe(16);
    expect(l.rowsPerImage).toBe(1);
    expect(l.byteLength).toBe(16);
  });
});

describe('deriveMipUploadLayout -- mip-major offset accumulation (w29)', () => {
  it('bc7 8x8 4-level chain accumulates offsets with block-padded tails', () => {
    // levels: 8x8, 4x4, 2x2, 1x1 (2x2 and 1x1 pad up to a full 4x4 block)
    const layout = deriveMipUploadLayout('bc7-rgba-unorm', 8, 8, 4);
    expect(layout).toHaveLength(4);

    const expected: readonly Pick<
      MipUploadLevel,
      'width' | 'height' | 'bytesPerRow' | 'rowsPerImage' | 'byteOffset' | 'byteLength'
    >[] = [
      { width: 8, height: 8, bytesPerRow: 32, rowsPerImage: 2, byteOffset: 0, byteLength: 64 },
      { width: 4, height: 4, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 64, byteLength: 16 },
      { width: 2, height: 2, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 80, byteLength: 16 },
      { width: 1, height: 1, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 96, byteLength: 16 },
    ];
    for (let i = 0; i < expected.length; i++) {
      const l = layout[i] as MipUploadLevel;
      expect(l.level).toBe(i);
      expect({
        width: l.width,
        height: l.height,
        bytesPerRow: l.bytesPerRow,
        rowsPerImage: l.rowsPerImage,
        byteOffset: l.byteOffset,
        byteLength: l.byteLength,
      }).toEqual(expected[i]);
    }
    expect(totalBytes(layout)).toBe(112);
  });

  it('bc1 non-square 12x6 3-level chain (0.5bpp) offsets are contiguous', () => {
    // 12x6 -> 6x3 -> 3x1  (bc1 = 8 bytes/block, 4x4)
    const layout = deriveMipUploadLayout('bc1-rgba-unorm', 12, 6, 3);
    // level0 12x6: bpr=ceil(12/4)*8=24, rpi=ceil(6/4)=2, len=48, off=0
    // level1 6x3:  bpr=ceil(6/4)*8=16, rpi=ceil(3/4)=1, len=16, off=48
    // level2 3x1:  bpr=ceil(3/4)*8=8,  rpi=1,           len=8,  off=64
    expect(layout.map((l) => l.byteOffset)).toEqual([0, 48, 64]);
    expect(layout.map((l) => l.byteLength)).toEqual([48, 16, 8]);
    expect(totalBytes(layout)).toBe(72);
  });

  it('single-level (no mip chain) returns one entry at offset 0', () => {
    const layout = deriveMipUploadLayout('bc7-rgba-unorm', 256, 256, 1);
    expect(layout).toHaveLength(1);
    expect(layout[0]?.byteOffset).toBe(0);
  });
});

describe('deriveMipUploadLayout -- physical full-subresource copy extents', () => {
  it('aligns non-block-aligned BC7 copies to physical storage', () => {
    const layout = deriveMipUploadLayout('bc7-rgba-unorm', 7, 5, 1);
    expect(layout[0]?.copyWidth).toBe(8);
    expect(layout[0]?.copyHeight).toBe(8);
  });

  it('aligns sub-block tail mip copies independently', () => {
    const layout = deriveMipUploadLayout('bc7-rgba-unorm', 8, 8, 4);
    expect(layout[2]?.width).toBe(2);
    expect(layout[2]?.copyWidth).toBe(4);
    expect(layout[2]?.copyHeight).toBe(4);
    expect(layout[3]?.width).toBe(1);
    expect(layout[3]?.copyWidth).toBe(4);
    expect(layout[3]?.copyHeight).toBe(4);
  });

  it('aligns non-square ASTC copies with its own block dimensions', () => {
    const layout = deriveMipUploadLayout('astc-8x5-unorm', 5, 3, 1);
    expect(layout[0]?.copyWidth).toBe(8);
    expect(layout[0]?.copyHeight).toBe(5);
  });
});

describe('deriveTextureExtent -- logical asset extent to physical storage extent (w35)', () => {
  it('derives BC7 physical storage and a logical UV scale without changing logical metadata', () => {
    expect(deriveTextureExtent('bc7-rgba-unorm', 2085, 1573)).toEqual({
      logicalExtent: { width: 2085, height: 1573 },
      physicalExtent: { width: 2088, height: 1576 },
      uvScale: [2085 / 2088, 1573 / 1576],
    });
  });

  it('derives each 4x4 tail mip independently', () => {
    expect(deriveTextureExtent('bc7-rgba-unorm', 2, 1)).toEqual({
      logicalExtent: { width: 2, height: 1 },
      physicalExtent: { width: 4, height: 4 },
      uvScale: [0.5, 0.25],
    });
  });

  it('uses the codec block-format table for a non-4x4 format', () => {
    expect(deriveTextureExtent('astc-6x6-unorm', 7, 8)).toEqual({
      logicalExtent: { width: 7, height: 8 },
      physicalExtent: { width: 12, height: 12 },
      uvScale: [7 / 12, 8 / 12],
    });
  });

  it('keeps uncompressed textures at identity extent and scale', () => {
    expect(deriveTextureExtent('rgba8unorm', 17, 9)).toEqual({
      logicalExtent: { width: 17, height: 9 },
      physicalExtent: { width: 17, height: 9 },
      uvScale: [1, 1],
    });
  });
});
