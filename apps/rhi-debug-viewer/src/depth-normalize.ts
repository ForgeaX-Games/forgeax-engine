// depth-normalize.ts — two-pass auto-normalize for depth buffer visualization.
//
// Pure function (zero GPU, zero React). Takes a depth32float GPU buffer readback
// (ArrayBuffer from mapAsync) with rows padded to 256-byte alignment, performs:
//   Pass 1: isFinite-gated min/max scan over all texels (stride-aware)
//   Pass 2: (v - min) / range clamped to [0, 1]
//   Degenerate: range <= 0 || !isFinite(range) -> fill 0.5 uniform gray
//
// Returns normalized Float32Array (tight, no padding) + metadata (min/max/validTexels).
//
// KB reference: webgpu-depth-visualize-normalize-algorithm.md section 2-3.
// Drives per-selection depth grayscale thumbnail in TextureViewer (w25).
//
// Related: plan-strategy D-4; research Finding 10; requirements AC-17/AC-32.

export interface DepthVisualizeResult {
  readonly data: Float32Array;
  readonly min: number;
  readonly max: number;
  readonly validTexels: number;
}

/**
 * Normalize raw depth32float buffer data into [0,1] grayscale range.
 *
 * The input mappedBuffer is the raw GPU-returned ArrayBuffer from
 * readbackTexturePixels with bytesPerTexel=4. Rows are padded to
 * 256-byte alignment (bytesPerRowAligned). The function uses
 * stride = bytesPerRowAligned / 4 to skip padding bytes.
 *
 * Degenerate case (range <= 0): all output values are 0.5 (uniform gray),
 * no NaN/Inf produced.
 *
 * @param mappedBuffer - Raw depth buffer bytes from mapAsync. Accepts any
 *   ArrayBufferLike since Float32Array views a typed array's .buffer, whose
 *   static type widened to include SharedArrayBuffer in recent TS libs.
 * @param width - Logical texture width in pixels.
 * @param height - Logical texture height in pixels.
 * @param bytesPerRowAligned - Padded row byte count (Math.ceil(width*4/256)*256).
 */
export function normalizeDepth(
  mappedBuffer: ArrayBufferLike,
  width: number,
  height: number,
  bytesPerRowAligned: number,
): DepthVisualizeResult {
  const stride = bytesPerRowAligned / 4; // float count per padded row
  const src = new Float32Array(mappedBuffer);

  // Pass 1: min/max scan (isFinite-gated per KB algorithm)
  let min = Infinity;
  let max = -Infinity;
  let validTexels = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    for (let x = 0; x < width; x++) {
      const v = src[rowOffset + x] as number;
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
        validTexels++;
      }
    }
  }

  const range = max - min;
  const result = new Float32Array(width * height);

  // Degenerate: no variation, all values equal, or no valid data
  if (range <= 0 || !Number.isFinite(range)) {
    result.fill(0.5);
    return { data: result, min, max, validTexels };
  }

  // Pass 2: normalize each texel to [0, 1]
  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    const dstOffset = y * width;
    for (let x = 0; x < width; x++) {
      const v = src[rowOffset + x] as number;
      const normalized = Number.isFinite(v) ? (v - min) / range : 0.5;
      result[dstOffset + x] = Math.max(0, Math.min(1, normalized));
    }
  }

  return { data: result, min, max, validTexels };
}
