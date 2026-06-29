// depth-normalize.unit.test.ts — unit tests for depth auto-normalize pure function.
//
// Tests the two-pass auto-normalize algorithm (Pass1: isFinite-gate min/max scan;
// Pass2: (v-min)/range clamp [0,1]) including the degenerate case (min==max)
// where range=0 — the function must fill 0.5 uniformly, all finite, no NaN/Inf.
//
// AC-17: known depth distribution covers full [0,1] range.
// AC-32: min==max produces uniform 0.5, all finite, no NaN/Inf.
//
// Related: plan-strategy D-4; research Finding 10; requirements AC-17/AC-32.
// w15 (test, red phase — normalizeDepth module created in w17).

import { describe, expect, it } from 'vitest';
import { normalizeDepth } from '../depth-normalize';

// ============================================================================
// Helper: construct a depth buffer (ArrayBuffer) with aligned row padding
// ============================================================================

/**
 * Build a depth buffer as ArrayBuffer with aligned row padding.
 *
 * The real depth buffer from mapAsync has rows padded to 256-byte alignment.
 * bytesPerRowAligned = Math.ceil(width * 4 / 256) * 256.
 * This helper simulates that layout so the normalize function can be tested
 * with padding between rows.
 */
function buildDepthBuffer(
  width: number,
  height: number,
  values: Float32Array | number[],
): ArrayBuffer {
  const bytesPerRowAligned = Math.ceil((width * 4) / 256) * 256;
  const buffer = new ArrayBuffer(bytesPerRowAligned * height);
  const view = new Float32Array(buffer);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (bytesPerRowAligned / 4);
    for (let x = 0; x < width; x++) {
      const srcIdx = y * width + x;
      view[rowOffset + x] = values[srcIdx] ?? 0;
    }
  }
  return buffer;
}

// ============================================================================
// AC-17: known depth distribution covers full [0,1] range
// ============================================================================

describe('normalizeDepth — known distribution (AC-17)', () => {
  it('maps known depth values to full [0,1] range', () => {
    const values = new Float32Array([0.1, 0.5, 0.9, 0.3, 0.2, 0.7, 0.4, 0.6]);
    const buffer = buildDepthBuffer(4, 2, values);
    const bytesPerRowAligned = Math.ceil((4 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 4, 2, bytesPerRowAligned);

    for (let i = 0; i < result.data.length; i++) {
      expect(Number.isFinite(result.data[i]), `result[${i}] must be finite`).toBe(true);
    }

    expect(result.min).toBeCloseTo(0.1);
    expect(result.max).toBeCloseTo(0.9);

    const normalizedMin = Math.min(...result.data);
    const normalizedMax = Math.max(...result.data);
    expect(normalizedMin).toBeLessThan(0.1);
    expect(normalizedMax).toBeGreaterThan(0.9);
  });

  it('produces validTexels equal to the number of finite input values', () => {
    const values = new Float32Array([0.1, 0.5, 0.9, 0.3]);
    const buffer = buildDepthBuffer(2, 2, values);
    const bytesPerRowAligned = Math.ceil((2 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 2, 2, bytesPerRowAligned);
    expect(result.validTexels).toBe(4);
  });
});

// ============================================================================
// AC-32: min==max degenerate case — no divide-by-zero, uniform 0.5 fill
// ============================================================================

describe('normalizeDepth — degenerate min==max (AC-32)', () => {
  it('produces uniform 0.5 when all depth values are equal (all-0 cleared buffer)', () => {
    const values = new Float32Array([0, 0, 0, 0]);
    const buffer = buildDepthBuffer(2, 2, values);
    const bytesPerRowAligned = Math.ceil((2 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 2, 2, bytesPerRowAligned);

    for (let i = 0; i < result.data.length; i++) {
      expect(
        Number.isFinite(result.data[i]),
        `result[${i}] must be finite, got ${result.data[i]}`,
      ).toBe(true);
    }

    const first = result.data[0] as number;
    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i]).toBe(first);
    }
    expect(first).toBe(0.5);
  });

  it('produces uniform 0.5 when all depth values are the same non-zero value (e.g. 0.3)', () => {
    const values = new Float32Array([0.3, 0.3, 0.3, 0.3]);
    const buffer = buildDepthBuffer(2, 2, values);
    const bytesPerRowAligned = Math.ceil((2 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 2, 2, bytesPerRowAligned);

    for (let i = 0; i < result.data.length; i++) {
      expect(Number.isFinite(result.data[i])).toBe(true);
    }

    const first = result.data[0] as number;
    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i]).toBe(first);
    }
    expect(first).toBe(0.5);
  });

  it('produces uniform 0.5 with validTexels=0 when all values are NaN', () => {
    const values = new Float32Array([NaN, NaN, NaN, NaN]);
    const buffer = buildDepthBuffer(2, 2, values);
    const bytesPerRowAligned = Math.ceil((2 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 2, 2, bytesPerRowAligned);

    for (let i = 0; i < result.data.length; i++) {
      expect(Number.isFinite(result.data[i])).toBe(true);
    }

    expect(result.validTexels).toBe(0);

    const first = result.data[0] as number;
    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i]).toBe(first);
    }
    expect(first).toBe(0.5);
  });
});

// ============================================================================
// NaN/Inf filtering in min/max scan
// ============================================================================

describe('normalizeDepth — NaN/Inf filtering', () => {
  it('filters NaN and Infinity from min/max scan, normalizes only finite values', () => {
    const values = new Float32Array([0.1, NaN, 0.9, Infinity, -Infinity, 0.5]);
    const buffer = buildDepthBuffer(3, 2, values);
    const bytesPerRowAligned = Math.ceil((3 * 4) / 256) * 256;

    const result = normalizeDepth(buffer, 3, 2, bytesPerRowAligned);

    expect(result.validTexels).toBe(3);

    expect(result.min).toBeCloseTo(0.1);
    expect(result.max).toBeCloseTo(0.9);

    for (let i = 0; i < result.data.length; i++) {
      expect(Number.isFinite(result.data[i])).toBe(true);
    }
  });
});
