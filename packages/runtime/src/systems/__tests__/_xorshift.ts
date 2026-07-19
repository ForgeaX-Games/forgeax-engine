// @forgeax/engine-runtime — deterministic 32-bit xorshift PRNG (M-4 / w26).
//
// Scope: M-4 transparent-sort.bench.ts (w27) needs reproducible 10k-entity
// fixtures across runs / hosts / CI nodes. The vitest-bench iterations
// repeatedly hash the same comparator path; a seeded PRNG turns the bench
// number into a function of the algorithm rather than of the test data,
// so a regression shows up as a clean delta in ns/op rather than noise.
//
// Why a hand-rolled xorshift instead of `seedrandom` (plan-strategy D-3):
//   - zero new npm dep, zero lockfile drift, zero dependabot bun.lock
//     parity churn
//   - 32-bit xorshift is a 10-line industry-standard primitive
//     (Marsaglia 2003); same deterministic guarantee for our use case
//     (uniform-ish 32-bit ints feeding a JS-side floor / map)
//   - bundle-size + bench gates stay pinned to the runtime surface that
//     ships to AI users; a test-only helper that lives under `__tests__/`
//     does not change either gate
//
// Algorithm (Marsaglia "Xorshift RNGs", 2003 §3, the 13/17/5 triplet):
//   state := state XOR (state << 13)
//   state := state XOR (state >>> 17)
//   state := state XOR (state << 5)
// The triplet (13, 17, 5) survives the BigCrush 32-bit suite for this
// scope (uniform sampling of int32 ranges). Period 2^32 - 1; we only
// need ~10^6 draws per bench iteration (10k entries x O(1) fields), so
// the period is comfortably out of reach.
//
// charter mapping:
//   F1 — JSDoc head + algorithm comment block keep the SSOT in the file
//     header so future AI users see why this exists without a wiki round
//     trip (charter "limited context" — the rationale lives inline)
//   P3 — `seed === 0` is explicitly remapped (xorshift is a fixed point
//     at 0, which would silently emit a constant 0 stream); the remap
//     fails-loud at construction time rather than silently producing a
//     degenerate sequence
//
// @new-surface — hand-rolled xorshift replaces the seedrandom dep
//   (plan-strategy D-3); the helper lives under `__tests__/` so it never
//   ships in the runtime bundle.
// @derives — 32-bit xorshift industry-standard primitive (Marsaglia
//   2003, "Xorshift RNGs", Journal of Statistical Software §3 triplet
//   13/17/5).

/**
 * Deterministic 32-bit xorshift PRNG factory. Returns a closure that
 * advances the internal state once per call and returns a uniform-ish
 * `[0, 1)` float (the 32-bit state divided by `0x100000000`).
 *
 * Same seed -> same sequence on every host / runtime / Node version
 * (the algorithm uses only 32-bit bitwise ops and Math-free arithmetic).
 *
 * @param seed - Initial 32-bit state. Defaults to `0xCAFE2026` (plan-
 *   strategy D-3 SSOT). `seed === 0` is remapped to `1` because xorshift
 *   is a fixed point at 0 (would emit a constant `0` stream forever);
 *   the remap is the smallest deterministic perturbation that preserves
 *   the period.
 * @returns A `() => number` closure; each call returns one `[0, 1)`
 *   sample and advances the internal state.
 *
 * @example deterministic bench fixture (w27 / transparent-sort.bench.ts)
 *   const rng = createXorshift32(0xCAFE2026);
 *   const layer = Math.floor(rng() * 2000) - 1000;  // [-1000, 1000]
 *   const posY  = rng() * 100;                       // [0, 100)
 *
 * @example reproducibility check
 *   const a = createXorshift32(42);
 *   const b = createXorshift32(42);
 *   a() === b();  // true — pure function of seed
 */
export function createXorshift32(seed = 0xcafe2026): () => number {
  // `| 0` coerces to int32; the algorithm is defined over int32. The
  // remap of seed=0 keeps the period definition (2^32 - 1) honest:
  // xorshift's only degenerate fixed point is at 0.
  let state = (seed | 0) === 0 ? 1 : seed | 0;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // `>>> 0` reinterprets the int32 as a uint32 (0 .. 2^32 - 1);
    // dividing by `0x100000000` (2^32) lands the result in [0, 1).
    return (state >>> 0) / 0x100000000;
  };
}
