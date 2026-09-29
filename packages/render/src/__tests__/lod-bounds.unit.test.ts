import { describe, expect, it } from 'vitest';
import {
  type BoundsCandidate,
  conservativeBounds,
  conservativeVisibleCandidate,
  encloseBounds,
} from '../scene/visibility/bounds';

describe('LOD conservative bounds', () => {
  it('encloses root and lower-level bounds', () => {
    expect(
      encloseBounds([
        conservativeBounds([-1, -1, -1], [1, 1, 1]),
        conservativeBounds([-2, 0, -0.5], [0.5, 3, 0.5]),
      ]),
    ).toEqual({ min: [-2, -1, -1], max: [1, 3, 1] });
  });

  it('normalizes inverted bounds into a conservative enclosure', () => {
    expect(conservativeBounds([2, 3, 4], [-2, -3, -4])).toEqual({
      min: [-2, -3, -4],
      max: [2, 3, 4],
    });
  });

  it.each<BoundsCandidate>([
    { bounds: undefined, transparent: false, deformed: false },
    { bounds: undefined, transparent: true, deformed: false },
    { bounds: undefined, transparent: false, deformed: true },
  ])('keeps non-queryable candidates conservatively visible: %o', (candidate) => {
    expect(conservativeVisibleCandidate(candidate)).toEqual({ visible: true, queryable: false });
  });

  it('marks stable opaque bounded candidates queryable', () => {
    const bounds = conservativeBounds([-1, -1, -1], [1, 1, 1]);
    expect(conservativeVisibleCandidate({ bounds, transparent: false, deformed: false })).toEqual({
      visible: false,
      queryable: true,
      bounds,
    });
  });
});
