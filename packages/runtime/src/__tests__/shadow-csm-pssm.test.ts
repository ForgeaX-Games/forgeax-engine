// shadow-csm-pssm.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M2 / w6: PSSM split function unit test (RED, test-first).
//
// PSSM formula (plan-strategy section 2 decision D-8):
//   C_i = λ · n · (f/n)^(i/m) + (1-λ) · (n + i/m · (f-n))
//   where i = 1..m, m = cascadeCount, n = nearPlane, f = farPlane
//
// Covers AC-04: split numerical correctness / monotonicity / λ degeneration /
// near≈far error / N=1..4 end-to-end.

import { describe, expect, it } from 'vitest';
import { pssmSplit } from '../render-system-extract';

// ── Hand-calculated anchors ────────────────────────────────────────────────
//
// λ=0.75, n=0.1, f=100, m=4:
//   log  term: n·(f/n)^(i/4) = 0.1 · (1000)^(i/4)
//   uniform term: n + i/4·(f-n) = 0.1 + i·24.975
//
//   i=1: log = 0.1·1000^0.25 = 0.1·5.6234 ≈ 0.5623
//         uni = 0.1 + 1·24.975 = 25.075
//         C1  = 0.75·0.5623 + 0.25·25.075 = 0.4217 + 6.2688 = 6.6905
//
//   i=2: log = 0.1·1000^0.5 = 0.1·31.6228 ≈ 3.1623
//         uni = 0.1 + 2·24.975 = 50.05
//         C2  = 0.75·3.1623 + 0.25·50.05 = 2.3717 + 12.5125 = 14.8842
//
//   i=3: log = 0.1·1000^0.75 = 0.1·177.8279 ≈ 17.7828
//         uni = 0.1 + 3·24.975 = 75.025
//         C3  = 0.75·17.7828 + 0.25·75.025 = 13.3371 + 18.7563 = 32.0934
//
//   i=4: log = 0.1·1000^1.0 = 100.0
//         uni = 0.1 + 4·24.975 = 100.0
//         C4  = 0.75·100 + 0.25·100 = 100.0
//
// Monotonicity: C1 < C2 < C3 < C4 = 100.0

describe('PSSM split function (w6)', () => {
  const EPS = 0.01;

  // biome-ignore lint/style/noNonNullAssertion: Float32Array indexed access in test assertions
  const at = (a: Float32Array, i: number): number => a[i]!;

  // biome-ignore lint/style/noNonNullAssertion: Float32Array indexed access in test assertions
  const prev = (a: Float32Array, i: number): number => a[i - 1]!;

  describe('λ=1 (pure logarithmic)', () => {
    it('produces exponentially spaced splits', () => {
      const result = pssmSplit(0.1, 100, 4, 1.0);
      expect(result.length).toBe(4);
      expect(at(result, 0)).toBeCloseTo(0.5623, 2);
      expect(at(result, 3)).toBeCloseTo(100.0, 4);
      for (let i = 1; i < 4; i++) {
        expect(at(result, i)).toBeGreaterThan(prev(result, i));
      }
    });
  });

  describe('λ=0 (pure uniform)', () => {
    it('produces linearly spaced splits', () => {
      const result = pssmSplit(0.1, 100, 4, 0);
      expect(result.length).toBe(4);
      expect(at(result, 0)).toBeCloseTo(25.075, 2);
      expect(at(result, 1)).toBeCloseTo(50.05, 2);
      expect(at(result, 2)).toBeCloseTo(75.025, 2);
      expect(at(result, 3)).toBeCloseTo(100.0, 4);
      for (let i = 1; i < 4; i++) {
        expect(at(result, i)).toBeGreaterThan(prev(result, i));
      }
    });
  });

  describe('λ=0.75 (default PSSM blend)', () => {
    it('produce monotonically increasing values between log and uniform', () => {
      const result = pssmSplit(0.1, 100, 4, 0.75);
      expect(result.length).toBe(4);
      expect(at(result, 0)).toBeCloseTo(6.6905, 2);
      expect(at(result, 1)).toBeCloseTo(14.8842, 2);
      expect(at(result, 2)).toBeCloseTo(32.0934, 2);
      expect(at(result, 3)).toBeCloseTo(100.0, 3);
      for (let i = 1; i < 4; i++) {
        expect(at(result, i)).toBeGreaterThan(prev(result, i));
      }
    });

    it('split values lie between pure uniform and pure log', () => {
      const blend = pssmSplit(0.1, 100, 4, 0.75);
      const uniform = pssmSplit(0.1, 100, 4, 0);
      const log = pssmSplit(0.1, 100, 4, 1.0);
      for (let i = 0; i < 3; i++) {
        const b = at(blend, i);
        const u = at(uniform, i);
        const l = at(log, i);
        expect(b).toBeGreaterThan(Math.min(l, u) - EPS);
        expect(b).toBeLessThan(Math.max(l, u) + EPS);
      }
    });
  });

  describe('N=1 (single cascade)', () => {
    it('returns array with far plane only', () => {
      const result = pssmSplit(0.1, 100, 1, 0.75);
      expect(result.length).toBe(1);
      expect(at(result, 0)).toBeCloseTo(100.0, 4);
    });
  });

  describe('N=2..4 end-to-end', () => {
    it('N=2 produces monotonic 2-element array', () => {
      const result = pssmSplit(0.1, 100, 2, 0.75);
      expect(result.length).toBe(2);
      expect(at(result, 0)).toBeGreaterThan(0);
      expect(at(result, 0)).toBeLessThan(at(result, 1));
      expect(at(result, 1)).toBeCloseTo(100.0, 4);
    });

    it('N=3 produces monotonic 3-element array', () => {
      const result = pssmSplit(0.1, 100, 3, 0.75);
      expect(result.length).toBe(3);
      for (let i = 1; i < 3; i++) {
        expect(at(result, i)).toBeGreaterThan(prev(result, i));
      }
      expect(at(result, 2)).toBeCloseTo(100.0, 4);
    });

    it('N=4 produces monotonic 4-element array', () => {
      const result = pssmSplit(0.1, 100, 4, 0.75);
      expect(result.length).toBe(4);
      for (let i = 1; i < 4; i++) {
        expect(at(result, i)).toBeGreaterThan(prev(result, i));
      }
      expect(at(result, 3)).toBeCloseTo(100.0, 4);
    });
  });

  describe('nearPlane ≈ farPlane degenerate', () => {
    it('throws ShadowInvalidConfigError when farPlane <= nearPlane + epsilon', () => {
      expect(() => pssmSplit(10, 10, 4, 0.75)).toThrow();
      expect(() => pssmSplit(10, 10.0000001, 4, 0.75)).toThrow();
    });
  });
});
