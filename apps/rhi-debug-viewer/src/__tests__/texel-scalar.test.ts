// texel-scalar.test.ts — sampleScalar unit tests (bug #4 depth/stencil pixel readout).
//
// sampleScalar reads one texel from a tight (stride = width) scalar array, used
// by the texel picker to report the raw depth / stencil value under the cursor.

import { describe, expect, it } from 'vitest';
import { sampleScalar } from '../texel-scalar';

describe('sampleScalar', () => {
  it('reads the value at a row-major (x, y) offset', () => {
    // 4x3 tight array. Texel (2, 1) -> index 1*4 + 2 = 6.
    const data = new Float32Array(4 * 3);
    data[6] = 0.997;
    expect(sampleScalar(data, 4, 3, 2, 1)).toBeCloseTo(0.997, 5);
  });

  it('reads the origin texel', () => {
    const data = new Float32Array([0.25, 0.5, 0.75, 1]);
    expect(sampleScalar(data, 2, 2, 0, 0)).toBeCloseTo(0.25, 5);
  });

  it('returns null when x is out of bounds', () => {
    const data = new Float32Array(4);
    expect(sampleScalar(data, 2, 2, 2, 0)).toBeNull();
  });

  it('returns null when y is out of bounds', () => {
    const data = new Float32Array(4);
    expect(sampleScalar(data, 2, 2, 0, 2)).toBeNull();
  });

  it('returns null for negative coordinates', () => {
    const data = new Float32Array(4);
    expect(sampleScalar(data, 2, 2, -1, 0)).toBeNull();
    expect(sampleScalar(data, 2, 2, 0, -1)).toBeNull();
  });

  it('returns null when the computed index exceeds the array length', () => {
    // Array shorter than width*height (defensive): index past end -> null.
    const data = new Float32Array(3); // claims 2x2 but only 3 entries
    expect(sampleScalar(data, 2, 2, 1, 1)).toBeNull();
  });
});
