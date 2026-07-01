// relax-depth-compare.unit.test.ts -- unit tests for the preview depth-compare relax.
//
// The shader-edit Apply path commits-through-draw N before re-encoding draw N
// with depthLoadOp:'load'. The re-issued draw is depth-tested against the depth
// it just wrote (z == z), so a STRICT compare ('less' / reverse-Z 'greater')
// discards every fragment and the preview never changes despite a successful
// compile + pipeline rebuild. relaxDepthCompare maps the strict compares to
// their non-strict siblings so the self-equal re-draw passes; every other compare
// (already non-strict, or order-independent) is passed through unchanged.
//
// The GPU-level proof that this fixes the symptom lives in the dawn mechanism
// test (compile-and-render.dawn.test.ts); this unit test locks the mapping table.

import { describe, expect, it } from 'vitest';
import { relaxDepthCompare } from '../compile-and-render';

describe('relaxDepthCompare', () => {
  it('relaxes the two strict compares to non-strict siblings', () => {
    expect(relaxDepthCompare('less')).toBe('less-equal');
    expect(relaxDepthCompare('greater')).toBe('greater-equal');
  });

  it('passes already-non-strict / order-independent compares through unchanged', () => {
    for (const c of [
      'less-equal',
      'greater-equal',
      'equal',
      'not-equal',
      'always',
      'never',
    ] as const) {
      expect(relaxDepthCompare(c)).toBe(c);
    }
  });

  it('passes undefined through (depthStencil with no depthCompare)', () => {
    expect(relaxDepthCompare(undefined)).toBeUndefined();
  });
});
