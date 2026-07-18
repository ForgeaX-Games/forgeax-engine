// @forgeax/engine-rhi-debug/src/__tests__/pixel-diff.unit.test.ts
// Unit tests for pixelDeltaAbsMean epsilon helper (m5b-2).
//
// 4 cases per plan-strategy §5.3.1:
// 1. Identity -> delta === 0 (strict)
// 2. Single-pixel +/-1/255 -> delta ≈ 0.00098 (<< 0.01 threshold)
// 3. Full inverse (orig=0, replay=255) -> delta === 1.0
// 4. Length mismatch / non-4 multiple -> throw DebugError code='replay-deterministic-violation'
//
// Related: AC-14; plan-strategy §5.3.1; m5b-2.

import { describe, expect, it } from 'vitest';
import { DebugError } from '../errors';
import { pixelDeltaAbsMean } from '../pixel-diff';

function makeBuffer(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('pixelDeltaAbsMean (m5b-2)', () => {
  it('identity: delta === 0 (strict, no float error)', () => {
    const orig = makeBuffer([0, 0, 0, 0, 128, 128, 128, 128]);
    const replay = makeBuffer([0, 0, 0, 0, 128, 128, 128, 128]);
    const delta = pixelDeltaAbsMean(orig, replay);
    expect(delta).toBe(0);
  });

  it('same buffer reference returns 0 immediately (identity short-circuit)', () => {
    const buf = makeBuffer([10, 20, 30, 40, 50, 60, 70, 80]);
    const delta = pixelDeltaAbsMean(buf, buf);
    expect(delta).toBe(0);
  });

  it('single pixel +/-1/255 -> delta ≈ 0.00098 (<< 0.01 threshold)', () => {
    const orig = makeBuffer([0, 0, 0, 0, 128, 128, 128, 128]);
    const replay = makeBuffer([1, 0, 0, 0, 128, 128, 128, 128]);
    const delta = pixelDeltaAbsMean(orig, replay);
    // |0-1| + |0-0| + |0-0| + |0-0| + same*4 = 1 total diff over 8 channels
    // mean = 1/8 = 0.125, / 255 = 0.000490...
    // Expect <= 0.001 (well within threshold)
    expect(delta).toBeCloseTo(1 / 255 / 8, 10);
    expect(delta).toBeLessThan(0.01);
  });

  it('full inverse (orig=0, replay=255) -> delta === 1.0', () => {
    const orig = makeBuffer([0, 0, 0, 0]);
    const replay = makeBuffer([255, 255, 255, 255]);
    const delta = pixelDeltaAbsMean(orig, replay);
    expect(delta).toBe(1.0);
  });

  it('length mismatch throws DebugError replay-deterministic-violation', () => {
    const orig = makeBuffer([0, 0, 0, 0]);
    const replay = makeBuffer([0, 0]);
    expect(() => pixelDeltaAbsMean(orig, replay)).toThrow(DebugError);
    try {
      pixelDeltaAbsMean(orig, replay);
    } catch (e) {
      expect(e).toBeInstanceOf(DebugError);
      const err = e as DebugError;
      expect(err.code).toBe('replay-deterministic-violation');
      expect(err.hint).toContain('length mismatch');
    }
  });

  it('non-4-multiple length throws DebugError replay-deterministic-violation', () => {
    const orig = makeBuffer([0, 0, 0, 0, 0]);
    const replay = makeBuffer([0, 0, 0, 0, 0]);
    expect(() => pixelDeltaAbsMean(orig, replay)).toThrow(DebugError);
    try {
      pixelDeltaAbsMean(orig, replay);
    } catch (e) {
      expect(e).toBeInstanceOf(DebugError);
      const err = e as DebugError;
      expect(err.code).toBe('replay-deterministic-violation');
      expect(err.hint).toContain('not a multiple of 4');
    }
  });
});
