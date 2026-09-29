import { describe, expect, it } from 'vitest';
import { buildDepthPyramidPlan, reduceDepthPyramidLevel } from '../depth-pyramid/plan';

describe('SSR Hi-Z contract', () => {
  it('derives a complete r32float mip chain for odd and minimum extents', () => {
    const odd = buildDepthPyramidPlan({ width: 5, height: 3 });
    expect(odd.format).toBe('r32float');
    expect(odd.mipLevelCount).toBe(3);
    expect(odd.levels).toEqual([
      { level: 0, width: 5, height: 3 },
      { level: 1, width: 2, height: 1 },
      { level: 2, width: 1, height: 1 },
    ]);

    const minimum = buildDepthPyramidPlan({ width: 1, height: 1 });
    expect(minimum.levels).toEqual([{ level: 0, width: 1, height: 1 }]);
  });

  it('preserves positive linear depth and infinity for an empty 2x2 reduction', () => {
    const reduced = reduceDepthPyramidLevel(
      new Float32Array([
        Number.POSITIVE_INFINITY,
        4,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ]),
      { width: 4, height: 2 },
    );
    expect(reduced).toEqual(new Float32Array([4, Number.POSITIVE_INFINITY]));
    expect(reduced.every((value) => value === Number.POSITIVE_INFINITY || value > 0)).toBe(true);
  });

  it('retains trailing row and column for an odd source extent without producing NaN', () => {
    const source = new Float32Array(7 * 3).fill(Number.POSITIVE_INFINITY);
    // The only finite sample is in the trailing source column and row. The
    // final destination cell must retain both edges through its footprint.
    source[2 * 7 + 6] = 7;
    const reduced = reduceDepthPyramidLevel(source, { width: 7, height: 3 });
    expect(reduced[2]).toBe(7);
    expect(Array.from(reduced).every(Number.isFinite)).toBe(false);
    expect(Array.from(reduced).every((value) => Number.isFinite(value) || value === Infinity)).toBe(
      true,
    );
  });

  it('overlaps the normalized 5-to-2 boundary so both cells retain source x=2', () => {
    const source = new Float32Array(5 * 2).fill(Number.POSITIVE_INFINITY);
    source[2] = 7;
    const reduced = reduceDepthPyramidLevel(source, { width: 5, height: 2 });
    expect(Array.from(reduced)).toEqual([7, 7]);
  });
});
