import { err, ok, type Result } from '../result.js';
import type { TextureMipPolicy, TextureShape } from './asset.js';
import {
  isCompressedFormat,
  type TextureError,
  textureError,
  validateTextureShape,
} from './errors.js';

export interface TextureLayoutInput {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly mips: TextureMipPolicy;
  /** Authored bytes: one base level for generate; the full declared chain for packed. */
  readonly actualByteLength?: number;
  readonly order?: string;
}

export interface TextureMipLayout {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly imagesPerMip: number;
  readonly bytesPerRow: number;
  readonly rowsPerImage: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface TextureLayout {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly levels: readonly TextureMipLayout[];
  readonly byteLength: number;
}

interface FormatLayout {
  readonly bytesPerBlock: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
}

function formatLayout(format: GPUTextureFormat): FormatLayout {
  if (isCompressedFormat(format)) {
    // RGB8 and RGB8A1 use 8-byte blocks; RGBA8 includes a separate alpha
    // block and needs 16 bytes. The broader "etc2-rgb" prefix includes both.
    if (format.startsWith('bc1') || format.startsWith('etc2-rgb8')) {
      return { bytesPerBlock: 8, blockWidth: 4, blockHeight: 4 };
    }
    return { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4 };
  }
  switch (format) {
    case 'r8unorm':
    case 'r8snorm':
    case 'r8uint':
    case 'r8sint':
      return { bytesPerBlock: 1, blockWidth: 1, blockHeight: 1 };
    case 'rg8unorm':
    case 'rg8snorm':
    case 'rg8uint':
    case 'rg8sint':
    case 'r16uint':
    case 'r16sint':
    case 'r16float':
      return { bytesPerBlock: 2, blockWidth: 1, blockHeight: 1 };
    case 'rgba16uint':
    case 'rgba16sint':
    case 'rgba16float':
    case 'rg32uint':
    case 'rg32sint':
    case 'rg32float':
      return { bytesPerBlock: 8, blockWidth: 1, blockHeight: 1 };
    case 'rgba32uint':
    case 'rgba32sint':
    case 'rgba32float':
      return { bytesPerBlock: 16, blockWidth: 1, blockHeight: 1 };
    default:
      return { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1 };
  }
}

function mipLevelCount(shape: TextureShape, mips: TextureMipPolicy): number {
  if (mips.kind === 'none') return 1;
  if (mips.kind === 'packed') return mips.levelCount;
  const { width, height } = shape.extent;
  let levels = 1;
  let largest = Math.max(width, height);
  if (shape.viewDimension === '3d') largest = Math.max(largest, shape.extent.depth);
  while (largest > 1) {
    largest = Math.max(1, largest >> 1);
    levels += 1;
  }
  return levels;
}

function imagesPerMip(shape: TextureShape, level: number): number {
  if (shape.viewDimension === '2d') return 1;
  if (shape.viewDimension === '2d-array') return shape.extent.layers;
  return Math.max(1, shape.extent.depth >> level);
}

/** Derive the canonical mip-major, image-major, row-major texture layout. */
export function deriveTextureLayout(
  input: TextureLayoutInput,
): Result<TextureLayout, TextureError> {
  const shapeResult = validateTextureShape(input.shape, input.mips, input.format);
  if (!shapeResult.ok) return shapeResult;

  if (input.order !== undefined && input.order !== 'mip-major,image-major,row-major') {
    return err(
      textureError(
        'texture-packing-invalid',
        {
          code: 'texture-packing-invalid',
          expectedBytes: 0,
          actualBytes: input.actualByteLength ?? 0,
          order: input.order,
        },
        'texture bytes must use mip-major, image-major, row-major order',
      ),
    );
  }

  const params = formatLayout(input.format);
  const levels: TextureMipLayout[] = [];
  let byteOffset = 0;
  const count = mipLevelCount(input.shape, input.mips);
  for (let level = 0; level < count; level++) {
    const width = Math.max(1, input.shape.extent.width >> level);
    const height = Math.max(1, input.shape.extent.height >> level);
    const blockColumns = Math.ceil(width / params.blockWidth);
    const rowsPerImage = Math.ceil(height / params.blockHeight);
    const bytesPerRow = blockColumns * params.bytesPerBlock;
    const byteLength = bytesPerRow * rowsPerImage * imagesPerMip(input.shape, level);
    levels.push({
      level,
      width,
      height,
      physicalWidth: blockColumns * params.blockWidth,
      physicalHeight: rowsPerImage * params.blockHeight,
      imagesPerMip: imagesPerMip(input.shape, level),
      bytesPerRow,
      rowsPerImage,
      byteOffset,
      byteLength,
    });
    byteOffset += byteLength;
  }

  // Generated levels occupy GPU storage but are not present in the source payload.
  const authoredBytes = input.mips.kind === 'generate' ? (levels[0]?.byteLength ?? 0) : byteOffset;
  if (input.actualByteLength !== undefined && input.actualByteLength !== authoredBytes) {
    return err(
      textureError(
        'texture-packing-invalid',
        {
          code: 'texture-packing-invalid',
          expectedBytes: authoredBytes,
          actualBytes: input.actualByteLength,
        },
        'texture data length must equal the derived canonical byte length',
      ),
    );
  }
  return ok({
    shape: input.shape,
    format: input.format,
    levels,
    byteLength: byteOffset,
  });
}
