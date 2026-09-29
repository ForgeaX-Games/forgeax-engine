import { describe, expect, it } from 'vitest';
import { deriveTextureLayout } from '../texture/layout.js';

describe('canonical texture layout', () => {
  it.each([
    ['etc2-rgb8unorm', 8],
    ['etc2-rgb8unorm-srgb', 8],
    ['etc2-rgb8a1unorm', 8],
    ['etc2-rgb8a1unorm-srgb', 8],
    ['etc2-rgba8unorm', 16],
    ['etc2-rgba8unorm-srgb', 16],
  ] as const)('keeps the ETC2 block size for %s across mip and layer strides', (format, bytes) => {
    const layout = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 7, height: 5, layers: 2 } },
      format,
      mips: { kind: 'packed', levelCount: 3 },
    }).unwrap();
    expect(
      layout.levels.map((level) => [level.bytesPerRow, level.byteOffset, level.byteLength]),
    ).toEqual([
      [bytes * 2, 0, bytes * 8],
      [bytes, bytes * 8, bytes * 2],
      [bytes, bytes * 10, bytes * 2],
    ]);
    expect(layout.byteLength).toBe(bytes * 12);
  });

  it.each([
    ['2d', { viewDimension: '2d', extent: { width: 3, height: 5 } }, 1],
    ['2d-array', { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 3 } }, 3],
    ['3d', { viewDimension: '3d', extent: { width: 3, height: 5, depth: 5 } }, 5],
  ] as const)('%s is mip-major and image-major', (_name, shape, baseImages) => {
    const result = deriveTextureLayout({
      shape,
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.levels).toHaveLength(3);
    expect(result.value.levels[0]?.imagesPerMip).toBe(baseImages);
    expect(result.value.levels[1]?.imagesPerMip).toBe(
      shape.viewDimension === '2d-array' ? 3 : shape.viewDimension === '3d' ? 2 : 1,
    );
    expect(result.value.levels[0]?.byteOffset).toBe(0);
    expect(result.value.levels[1]?.byteOffset).toBe(result.value.levels[0]?.byteLength);
    expect(result.value.byteLength).toBe(
      result.value.levels.reduce((sum, level) => sum + level.byteLength, 0),
    );
  });

  it('keeps array layers but shrinks 3d depth at odd mip extents', () => {
    const array = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 5, height: 3, layers: 3 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });
    const volume = deriveTextureLayout({
      shape: { viewDimension: '3d', extent: { width: 5, height: 3, depth: 5 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(array.ok && array.value.levels.map((level) => level.imagesPerMip)).toEqual([3, 3, 3]);
    expect(volume.ok && volume.value.levels.map((level) => level.imagesPerMip)).toEqual([5, 2, 1]);
  });

  it.each([
    'etc2-rgba8unorm',
    'etc2-rgba8unorm-srgb',
  ] as const)('%s uses the 16-byte ETC2 RGBA8 block size', (format) => {
    const result = deriveTextureLayout({
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format,
      mips: { kind: 'none' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.levels[0]).toMatchObject({
      bytesPerRow: 16,
      rowsPerImage: 1,
      byteLength: 16,
    });
    expect(result.value.byteLength).toBe(16);

    const nonAligned = deriveTextureLayout({
      shape: { viewDimension: '2d', extent: { width: 5, height: 4 } },
      format,
      mips: { kind: 'none' },
    });

    expect(nonAligned.ok).toBe(true);
    if (!nonAligned.ok) return;
    expect(nonAligned.value.levels[0]).toMatchObject({
      bytesPerRow: 32,
      rowsPerImage: 1,
      byteLength: 32,
    });
    expect(nonAligned.value.byteLength).toBe(32);
  });

  it('rejects wrong canonical byte length and order', () => {
    const result = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 2 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 2 },
      actualByteLength: 1,
      order: 'layer-major-before-mip',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'texture-packing-invalid' },
    });
  });
});

it('validates generated mips against only the authored base level while retaining GPU layout', () => {
  const result = deriveTextureLayout({
    shape: { viewDimension: '2d', extent: { width: 128, height: 128 } },
    format: 'rgba8unorm-srgb',
    mips: { kind: 'generate' },
    actualByteLength: 65536,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.levels).toHaveLength(8);
  expect(result.value.byteLength).toBe(87380);
  expect(
    deriveTextureLayout({
      shape: result.value.shape,
      format: result.value.format,
      mips: { kind: 'packed', levelCount: 8 },
      actualByteLength: 65536,
    }).ok,
  ).toBe(false);
});
