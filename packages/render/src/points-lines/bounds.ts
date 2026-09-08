import type { PointsLinesStyle } from './snapshot';

/**
 * Expands the local culling envelope by the maximum screen-space raster
 * radius. The shader applies the exact physical-pixel offset; this envelope
 * is deliberately conservative so transformed edge primitives are retained.
 */
export function expandPointsLinesBounds(
  bounds: ArrayLike<number>,
  style: PointsLinesStyle | undefined,
): Float32Array {
  if (bounds.length < 6 || style === undefined) return new Float32Array(bounds);
  const marginPx = style.kind === 'points' ? style.sizePx * 0.5 : style.widthPx * 0.5;
  if (!Number.isFinite(marginPx) || marginPx <= 0) return new Float32Array(bounds);
  return new Float32Array([
    (bounds[0] ?? 0) - marginPx,
    (bounds[1] ?? 0) - marginPx,
    (bounds[2] ?? 0) - marginPx,
    (bounds[3] ?? 0) + marginPx,
    (bounds[4] ?? 0) + marginPx,
    (bounds[5] ?? 0) + marginPx,
  ]);
}
