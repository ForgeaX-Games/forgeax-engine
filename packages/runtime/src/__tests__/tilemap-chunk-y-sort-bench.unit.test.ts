// tilemap-chunk-y-sort-bench.unit.test.ts (feat-20260608-tilemap-object-
// layer-rendering / M3 / m3-t3). Unit-bench locking the AC-17 perf budget for
// the per-cell entity foot-Y sort path: the LSD-radix `argsortInPlace` must
// stay dramatically faster than the generic comparator argsort it would
// degrade to if the specialisation were removed (plan-strategy R-4).
//
// The gate is an in-process RATIO, not an absolute ms budget: it asserts
// generic_time / radix_time >= SPEEDUP_FLOOR. Both paths run on the same CPU
// in the same process, so the ratio cancels machine speed -- an absolute ms
// floor instead flips red on slow CI runners (>20x speed spread) rather than
// on a real regression. A fallback to the O(n log n) comparator path drops the
// ratio to ~1x and trips the floor on any runner; a healthy radix path holds
// ~8-10x.
//
// Skipped under V8 coverage: `--coverage` instruments the ~100-line radix loop
// in production source (transparent-sort.ts) but barely touches the native
// `Array.sort()` baseline defined in this test file (excluded from coverage),
// so the ratio collapses to a deterministic ~1.4x. A wall-clock microbenchmark
// under statement-coverage instrumentation is not a valid measurement. No
// signal is lost: every change is gated on the no-coverage PR path before it
// can reach main (main-push CI is the coverage channel).
//
// FALSIFY=generic-fallback rewires the candidate to the generic path so the
// floor MUST fail, proving the gate can tell the fast path from the slow one
// (charter P3).

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { argsortInPlace } from '../systems/transparent-sort';

// vitest exposes the resolved worker config on globalThis; coverage.enabled is
// set by --coverage (main-push CI) and unset on the plain PR path.
function isCoverageInstrumented(): boolean {
  const worker = (
    globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }
  ).__vitest_worker__;
  return worker?.config?.coverage?.enabled === true;
}

const N_ENTRIES = 10_000;
const SPEEDUP_FLOOR = 3;
const FALSIFY = process.env.FORGEAX_FALSIFY_ARGSORT;

function buildKeys(): Float64Array {
  const keys = new Float64Array(N_ENTRIES);
  let seed = 0x13571357;
  for (let i = 0; i < N_ENTRIES; i++) {
    seed = (seed * 1664525 + 1013904223) | 0;
    keys[i] = ((seed >>> 0) / 0xffffffff) * 1000 - 500;
  }
  return keys;
}

function genericArgsort(keys: Float64Array, indices: Int32Array): void {
  const order = Array.from(indices);
  order.sort((a, b) => (keys[a] as number) - (keys[b] as number));
  for (let i = 0; i < order.length; i++) indices[i] = order[i] as number;
}

function timeSortOnce(run: (idx: Int32Array) => void, scratch: Int32Array): number {
  for (let i = 0; i < scratch.length; i++) scratch[i] = i;
  const t0 = performance.now();
  run(scratch);
  return performance.now() - t0;
}

describe('tilemap chunk Y-sort bench (m3-t3 / AC-17 radix-vs-generic / 10k)', () => {
  it.skipIf(isCoverageInstrumented())(
    `argsortInPlace is >= ${SPEEDUP_FLOOR}x faster than a generic comparator argsort at N=${N_ENTRIES}`,
    () => {
      const keys = buildKeys();
      const scratch = new Int32Array(N_ENTRIES);
      const generic = (idx: Int32Array): void => genericArgsort(keys, idx);
      const candidate =
        FALSIFY === 'generic-fallback'
          ? generic
          : (idx: Int32Array): void => argsortInPlace(keys, idx);

      // Interleave generic and candidate and keep the MIN of each: paired
      // samples share the same instantaneous load and wall-clock noise is
      // one-sided (a sample can only run slower than the true cost), so the
      // minimum is the least-perturbed ~= real algorithmic cost. Iteration 0 is
      // the warm-up (discarded); a handful more gives one clean sample each.
      let genericMin = Number.POSITIVE_INFINITY;
      let candidateMin = Number.POSITIVE_INFINITY;
      for (let m = 0; m < 8; m++) {
        const g = timeSortOnce(generic, scratch);
        const c = timeSortOnce(candidate, scratch);
        if (m === 0) continue;
        if (g < genericMin) genericMin = g;
        if (c < candidateMin) candidateMin = c;
      }

      const speedup = genericMin / candidateMin;

      if (FALSIFY === 'generic-fallback') {
        expect(speedup).toBeLessThan(SPEEDUP_FLOOR);
        return;
      }
      if (speedup < SPEEDUP_FLOOR) {
        console.warn(
          `[m3-t3] radix speedup below floor: radix=${candidateMin.toFixed(4)}ms ` +
            `generic=${genericMin.toFixed(4)}ms speedup=${speedup.toFixed(2)}x floor=${SPEEDUP_FLOOR}x`,
        );
      }
      expect(speedup).toBeGreaterThanOrEqual(SPEEDUP_FLOOR);
    },
  );
});
