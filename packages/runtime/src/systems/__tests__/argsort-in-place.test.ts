// argsortInPlace unit tests (feat-20260608-tilemap-object-layer-rendering
// M3 / m3-t1). The named export will land in m3-t2; until then every
// import below resolves to `undefined` and the suite is red.
//
// Spec (plan-strategy §D-3 + reference backup commit 31d96d75):
//   `argsortInPlace(keys: Float64Array, indices: Int32Array): void` reorders
//   `indices` in place so that `keys[indices[i]]` is non-decreasing. The key
//   array is treated as immutable; only `indices` is mutated. The sort is:
//
//     - stable (equal-key entries preserve their original `indices` order),
//     - NaN-safe (NaN keys land at the tail in stable order),
//     - IEEE-754 unsigned-monotonic encoded so `+0` and `-0` compare equal,
//     - zero-allocation per call (module-scoped scratch buffers grow on
//       demand; AC-17 budget is a separate bench, not this suite),
//     - safe at the empty / single-entry boundaries.
//
// Charter mapping: P3 (NaN / out-of-range entries deterministic, no silent
// throws) + P4 (single sort primitive shared with the sprite bucket via
// `transparent-sort.ts`).

import { describe, expect, it } from 'vitest';
import { argsortInPlace } from '../transparent-sort';

describe('argsortInPlace - 11-bit radix LSD over IEEE-754 unsigned-monotonic', () => {
  it('basic ascending: distinct positive keys land in ascending key order', () => {
    const keys = new Float64Array([3.1, 1.2, 2.7, 0.5, 9.0]);
    const indices = new Int32Array([0, 1, 2, 3, 4]);

    argsortInPlace(keys, indices);

    expect(Array.from(indices)).toEqual([3, 1, 2, 0, 4]);
  });

  it('all-equal keys: stable sort preserves the original index order', () => {
    const keys = new Float64Array([5, 5, 5, 5, 5]);
    const indices = new Int32Array([0, 1, 2, 3, 4]);

    argsortInPlace(keys, indices);

    expect(Array.from(indices)).toEqual([0, 1, 2, 3, 4]);
  });

  it('negative + zero + positive: IEEE-754 unsigned-monotonic sorts correctly', () => {
    const keys = new Float64Array([-3.5, 0, 2.1, -1.0, 7.2, -0.0]);
    const indices = new Int32Array([0, 1, 2, 3, 4, 5]);

    argsortInPlace(keys, indices);

    // -3.5, -1.0, 0/-0 (stable -> [1, 5]), 2.1, 7.2
    expect(Array.from(indices)).toEqual([0, 3, 1, 5, 2, 4]);
  });

  it('-0 and +0 are equal under the unsigned-monotonic encoding (stable tie)', () => {
    const keys = new Float64Array([0, -0, 0, -0]);
    const indices = new Int32Array([0, 1, 2, 3]);

    argsortInPlace(keys, indices);

    expect(Array.from(indices)).toEqual([0, 1, 2, 3]);
  });

  it('NaN keys land at the tail in stable order', () => {
    const keys = new Float64Array([2, Number.NaN, 0, Number.NaN, -1]);
    const indices = new Int32Array([0, 1, 2, 3, 4]);

    argsortInPlace(keys, indices);

    expect(indices[0]).toBe(4);
    expect(indices[1]).toBe(2);
    expect(indices[2]).toBe(0);
    expect(indices[3]).toBe(1);
    expect(indices[4]).toBe(3);
  });

  it('n=0: no-op, returns immediately without throwing', () => {
    const keys = new Float64Array(0);
    const indices = new Int32Array(0);

    expect(() => argsortInPlace(keys, indices)).not.toThrow();
    expect(indices.length).toBe(0);
  });

  it('n=1: no-op, single-entry indices unchanged', () => {
    const keys = new Float64Array([42]);
    const indices = new Int32Array([0]);

    argsortInPlace(keys, indices);

    expect(Array.from(indices)).toEqual([0]);
  });

  it('mutates indices in place, does not reallocate the caller buffer', () => {
    const keys = new Float64Array([5, 2, 9, 1]);
    const indices = new Int32Array([0, 1, 2, 3]);
    const indicesBuffer = indices.buffer;
    const indicesByteLength = indices.byteLength;

    argsortInPlace(keys, indices);

    expect(indices.buffer).toBe(indicesBuffer);
    expect(indices.byteLength).toBe(indicesByteLength);
    expect(Array.from(indices)).toEqual([3, 1, 0, 2]);
  });

  it('does not mutate the keys input', () => {
    const keys = new Float64Array([3, 1, 2]);
    const original = Array.from(keys);
    const indices = new Int32Array([0, 1, 2]);

    argsortInPlace(keys, indices);

    expect(Array.from(keys)).toEqual(original);
  });

  it('large N (5000): radix LSD result equals comparator-based reference', () => {
    const n = 5000;
    const keys = new Float64Array(n);
    const indices = new Int32Array(n);
    let seed = 1337;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) | 0;
      return ((seed >>> 0) / 0xffffffff) * 200 - 100;
    };
    for (let i = 0; i < n; i++) {
      keys[i] = next();
      indices[i] = i;
    }

    const referenceIndices = Array.from(indices).sort((a, b) => {
      const ka = keys[a] as number;
      const kb = keys[b] as number;
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a - b;
    });

    argsortInPlace(keys, indices);

    expect(Array.from(indices)).toEqual(referenceIndices);
  });

  it('subarray slice as indices: sorts only the visible window', () => {
    const keys = new Float64Array([10, 20, 5, 15, 30]);
    const buffer = new Int32Array([0, 1, 2, 3, 4]);
    const window = buffer.subarray(1, 4); // entries 1, 2, 3 (keys 20, 5, 15)

    argsortInPlace(keys, window);

    // Original entries by key ascending: 5 (->2), 15 (->3), 20 (->1)
    expect(Array.from(window)).toEqual([2, 3, 1]);
    // Outside-window slots untouched.
    expect(buffer[0]).toBe(0);
    expect(buffer[4]).toBe(4);
  });
});
