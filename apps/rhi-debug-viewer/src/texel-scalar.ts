// texel-scalar.ts — sample one texel from a tight scalar array (depth / stencil).
//
// The depth and stencil preview paths produce a tight (stride = width, no row
// padding) Float32Array of raw scalar values before the grayscale normalize. The
// texel picker reads one value from it to report the true depth/stencil under the
// cursor (bug #4), the single-channel analogue of decodeTexelRaw for color.

/**
 * Read the scalar at texel (x, y) from a row-major tight array.
 * @param data - Tight scalar array, length = width*height (stride = width).
 * @param width - Texture width in pixels.
 * @param height - Texture height in pixels.
 * @param x - 0-based column.
 * @param y - 0-based row.
 * @returns The scalar value, or null when (x, y) is out of bounds or the array
 *   is too short for the computed index.
 */
export function sampleScalar(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number | null {
  if (x < 0 || x >= width || y < 0 || y >= height) return null;
  const idx = y * width + x;
  if (idx >= data.length) return null;
  return data[idx] ?? null;
}
