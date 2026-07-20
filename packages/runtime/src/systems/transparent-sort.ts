// @forgeax/engine-runtime - transparent-sort.ts (feat-20260520-2d-sprite-
// layer-mvp / M-3 / w23). SoA Float64Array predicted-key sort consumed by
// the RenderSystem record stage (M-3 / w25) right before recording the
// transparent bucket.
//
// Algorithm (plan-strategy §2 next-tier decision D-8 SoA columnar
// Float64Array; chosen because pure JS Array.sort estimates 4 ms for 10k
// entries / 100 iter ((research §Finding D-2 estimate), and SoA Float64
// preset key sort estimates < 0.2 ms — well under the AC-14 0.5 ms p95
// budget):
//
//   1. Walk `entries` once and project each into:
//        - `layers   : Int32Array(n)`   — primary sort key (Layer.value).
//        - `sortVals : Float64Array(n)` — predicted sort value per entry,
//          derived from `mode` + `yzAlpha` + per-entry inputs OR the
//          per-entity `sortKey` override.
//        - `indices  : number[]`        — initially `[0..n)`.
//   2. `indices.sort((a, b) => ...)` with the composite comparator
//      `(layers[a] - layers[b]) || (sortVals[a] - sortVals[b])`.
//      Array.prototype.sort has been stable since ES2019; tie-breakers
//      fall back to insertion order (charter F1 deterministic output).
//   3. Return entries reordered by the sorted indices.
//
// Why SoA over Object-of-Structs comparator: V8's PSP / TimSort visits
// the comparator O(n log n) times; pulling `entry.layer` + recomputing
// the mode formula per comparator call would multiply cache misses + JS
// engine bridge overhead. Pre-projecting into Int32 + Float64 typed
// arrays keeps the comparator a pair of typed-array index loads (cache
// hot) + 1 / 2 subtractions.
//
// 3-mode formulas (requirements §3 AC-10 + plan-strategy §3.3 sort path):
//
//   | mode | mode constant                      | sortValue formula                                   |
//   |:-:|:----------------------------------|:----------------------------------------------------|
//   |  0 | `TRANSPARENT_SORT_MODE_LAYER_Z`   | `posZ`                                              |
//   |  1 | `TRANSPARENT_SORT_MODE_LAYER_Y`   | `-(posY - pivotY * sizeY)`                          |
//   |  2 | `TRANSPARENT_SORT_MODE_LAYER_YZ`  | `(posY - pivotY * sizeY) + yzAlpha * posZ`          |
//   |  3 | `TRANSPARENT_SORT_MODE_DISTANCE`  | `-(squared distance to cameraPos)`                   |
//
// SortKey override (requirements §3 AC-10 + AC-19 derivation row): when an
// entry carries `sortKey !== undefined`, its sortValue is REPLACED by the
// override - the layer remains the primary key, the mode formula is
// skipped. AI users use this to pin one sprite above / below the procedural
// ordering inside the same layer without reshaping the whole scene.
//
// @derives ECS archetypeStorage SoA column-of-arrays pattern (packages/ecs/
//   src/component.ts:6-9) — typed-array columns indexed by row position,
//   no per-row object allocation.
// @new-surface SoA Float64Array predicted-key sort over Object-of-Structs
//   comparator (research §Finding D-2 path 3); estimated < 0.2 ms p95 for
//   10k entries vs the 4 ms pure-Array.sort baseline; M-4 bench (w27)
//   validates against the 0.5 ms acceptance gate.
//
// charter mapping: F1 (single-import barrel — transparent-sort joins the
// existing render-system surface) + P3 (deterministic stable sort -
// charter "structured failure" extends to "deterministic ordering" inside
// the rendering pipeline; same-key entries preserve insertion order) + P4
// (consistent abstraction - the SoA columnar pattern mirrors the ECS
// archetypeStorage layout).

import type { World } from '@forgeax/engine-ecs';
import type { TransparentEntry } from '../render-system-extract';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './transparent-sort-config';

export type { TransparentEntry } from '../render-system-extract';

/**
 * Sort the transparent-bucket entries by `(layer ASC, sortValue ASC,
 * insertion-order)` and return the reordered list.
 *
 * The world is consumed read-only for `getTransparentSortConfig(world)`
 * (D-2 `hasResource` guard, never throws); no entity / component mutation.
 *
 * Sort stability: Array.prototype.sort is stable per ES2019 — entries that
 * share `(layer, sortValue)` keep their insertion order. This matters for
 * tests that spawn entities in a specific order and expect that order to
 * survive the sort when no other ordering signal is present.
 *
 * @example mode=0 horizontal-z + 4 entries crossing 3 layers
 *   const out = transparentSortEntries(entries, world);
 *   // entries with lower layer first; within a layer, lower posZ first.
 *
 * @example mode=1 JRPG Y-sort, foot pivot
 *   world.insertResource(TRANSPARENT_SORT_CONFIG_KEY,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_Y, yzAlpha: 1.0 });
 *   const out = transparentSortEntries(entries, world);
 *   // entries with deeper foot-Y draw later (back-to-front).
 *
 * @example SortKey override
 *   // entry { layer: 0, posY: 10, pivotY: 0.5, sizeY: 1, sortKey: -99 }
 *   // -> uses sortValue = -99 instead of the mode formula, but layer
 *   //    remains the primary key (foreground entries still draw last).
 */
export function transparentSortEntries(
  entries: readonly TransparentEntry[],
  world: World,
  cameraPos?: readonly [number, number, number],
): readonly TransparentEntry[] {
  const n = entries.length;
  if (n === 0) return entries;

  const cfg = getTransparentSortConfig(world);
  const mode = cfg.mode;
  const yzAlpha = cfg.yzAlpha;

  // SoA pre-projection columns. Float64Array gives sub-ms / 10k bench
  // headroom over Object-of-Structs comparator (D-8); Int32Array carries
  // the signed i32 Layer.value verbatim (negatives preserved).
  const layers = new Int32Array(n);
  const sortVals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i] as TransparentEntry;
    layers[i] = e.layer;
    sortVals[i] = computeSortValue(e, mode, yzAlpha, cameraPos);
  }

  // indices argsort — Array.prototype.sort stability (ES2019+) preserves
  // insertion order when the comparator returns 0. We avoid TypedArray.sort
  // because its stability is not specified by the ECMAScript standard.
  const indices: number[] = new Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  indices.sort((a, b) => {
    const la = layers[a] as number;
    const lb = layers[b] as number;
    if (la !== lb) return la - lb;
    const va = sortVals[a] as number;
    const vb = sortVals[b] as number;
    if (va !== vb) return va < vb ? -1 : 1;
    // Tertiary tiebreaker for modes 0/1/2: group same-materialHandle entries
    // together so consecutive equal-(layer, sortVal, materialHandle) runs can
    // collapse into fold buckets. Matches sortTransparentDispatch semantics.
    // Not applied for DISTANCE (mode 3) — ties at exact same camera distance
    // are undefined in depth order; stable insertion order is preserved there.
    if (mode !== TRANSPARENT_SORT_MODE_DISTANCE) {
      return (
        (entries[a] as TransparentEntry).materialHandle -
        (entries[b] as TransparentEntry).materialHandle
      );
    }
    return 0;
  });

  const sorted: TransparentEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sorted[i] = entries[indices[i] as number] as TransparentEntry;
  }
  return sorted;
}

/**
 * Per-entry sortValue projection. The 3 mode formulas + the SortKey
 * override are kept in a single branch ladder so V8 can inline the hot
 * path (research §Finding D-2 sort-loop pinning).
 *
 * mode!=0/1/2 is impossible at the helper entry by construction:
 * `setTransparentSortConfig` rejects out-of-range writes with
 * `ResourceInvalidValueError` (M-2 / w13) so the KV resource always holds
 * a valid mode; the `default` branch is a defensive fall-through to
 * mode=0 (horizontal-z, safe default; mirrors `getTransparentSortConfig`'s
 * KV-missing default).
 */
function computeSortValue(
  e: TransparentEntry,
  mode: number,
  yzAlpha: number,
  cameraPos?: readonly [number, number, number],
): number {
  if (e.sortKey !== undefined) return e.sortKey;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) {
    return -(e.posY - e.pivotY * e.sizeY);
  }
  if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) {
    return e.posY - e.pivotY * e.sizeY + yzAlpha * e.posZ;
  }
  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    // Squared-distance back-to-front: far objects draw first.
    // sortValue = -dist^2 so ASC comparator places far-first.
    if (cameraPos !== undefined) {
      const dx = e.posX - cameraPos[0];
      const dy = e.posY - cameraPos[1];
      const dz = e.posZ - cameraPos[2];
      return -(dx * dx + dy * dy + dz * dz);
    }
    // cameraPos missing fallback: use mode=0 posZ (defensive;
    // only reaches here when transparentSortEntries is called via
    // the 2-arg legacy path with mode=3. The 3-arg path with an
    // explicit cameraPos is the canonical API.)
    return e.posZ;
  }
  // TRANSPARENT_SORT_MODE_LAYER_Z (mode=0) + defensive default for any
  // out-of-range value that slipped past the helper guard.
  if (mode !== TRANSPARENT_SORT_MODE_LAYER_Z) {
    // Unreachable in practice — setTransparentSortConfig rejects writes
    // outside {0, 1, 2, 3} with ResourceInvalidValueError. Fall through to
    // the horizontal-z safe default (charter P3 explicit no-silent-coerce
    // is enforced by setTransparentSortConfig, not here; this fallback is
    // strictly defensive against direct world.insertResource writes that
    // bypass the typed helper).
    void mode;
  }
  return e.posZ;
}

// === argsortInPlace — feat-20260608-tilemap-object-layer-rendering M3 / m3-t2 ===
//
// In-place single-key argsort over a Float64Array key column. Reorders the
// caller's Int32Array `indices` so that `keys[indices[0]] <= keys[indices[1]]
// <= ... <= keys[indices[n-1]]`. Stable: equal-key entries preserve their
// original `indices` order. Does not mutate `keys`.
//
// Algorithm: 11-bit LSD radix sort (6 passes) over a 64-bit unsigned-
// monotonic encoding of each key (the IEEE-754 "sortable bits" trick: when
// the sign bit is set, flip all 64 bits; otherwise flip only the sign bit).
// The result is unsigned-comparable, so ascending raw-bit sort equals
// ascending key sort. NaN-bearing keys encode to the upper end of the
// unsigned space (above +Infinity) and therefore land at the tail in stable
// order without throwing. -0 and +0 collapse to the same encoded value and
// compare equal.
//
// Per-pass we permute only a position-counter `Int32Array` (4 bytes per
// entry) instead of the full (key + idx) tuple; the encoded key columns
// `kLo` / `kHi` (two `Uint32Array`s) let each pass read 11 contiguous bits
// via `>>>` + `&` without per-element BigInt allocation. Module-scoped
// scratch buffers (`argsortKey*` / `argsortPos*`) grow monotonically on
// demand so steady-state calls allocate zero bytes (plan-strategy §R-4).
//
// Performance anchor: this LSD radix path measures ~8-10x faster than a
// generic comparator argsort (V8 TimSort over an index array) at N=10_000
// keys, in process on the same CPU. The unit-bench in
// `__tests__/tilemap-chunk-y-sort-bench.unit.test.ts` (m3-t3) locks AC-17 as
// that machine-independent *ratio* (radix >= 3x faster than generic, wide
// jitter margin) rather than an absolute ms budget -- the original 0.5 ms
// floor flaked on slow CI runners (issue #477). The ratio is taken as the
// MIN of INTERLEAVED per-iteration timings (generic then radix back-to-back),
// which cancels both machine speed and transient contention; an earlier
// sequential-median ratio (PR #480) still flaked when a whole measurement
// block landed in a GC window (1.39x on CI). FALSIFY=generic-fallback swaps
// the candidate to the comparator path to prove the gate detects a
// fallback-to-O(n log n) regression.
//
// Charter mapping: P4 (sprite + tilemap-spawned cell entities consume one
// SoA argsort primitive) + P3 (NaN + out-of-range indices are encoded
// explicitly, never silently dropped — they land at the tail).

const ARGSORT_RADIX_BITS = 11;
const ARGSORT_BUCKETS = 1 << ARGSORT_RADIX_BITS; // 2048
const ARGSORT_FINAL_BUCKETS = 1 << 9; // 512 (final pass only carries 9 bits)
const ARGSORT_MASK = ARGSORT_BUCKETS - 1; // 0x7ff
const ARGSORT_FINAL_MASK = ARGSORT_FINAL_BUCKETS - 1; // 0x1ff

let argsortKeyLo = new Uint32Array(0);
let argsortKeyHi = new Uint32Array(0);
let argsortValueIdx = new Int32Array(0);
let argsortPosA = new Int32Array(0);
let argsortPosB = new Int32Array(0);
const argsortCounts = new Uint32Array(ARGSORT_BUCKETS);
const argsortOffsets = new Uint32Array(ARGSORT_BUCKETS);

const argsortKeyBuffer = new ArrayBuffer(8);
const argsortKeyF64View = new Float64Array(argsortKeyBuffer);
const argsortKeyU32View = new Uint32Array(argsortKeyBuffer);

function ensureArgsortCapacity(n: number): void {
  if (argsortKeyLo.length < n) {
    argsortKeyLo = new Uint32Array(n);
    argsortKeyHi = new Uint32Array(n);
    argsortValueIdx = new Int32Array(n);
    argsortPosA = new Int32Array(n);
    argsortPosB = new Int32Array(n);
  }
}

/**
 * In-place stable argsort over a Float64 key column.
 *
 * @param keys    immutable key column; `keys[i]` is the sort weight for the
 *                entry at original position `i`. Out-of-range positions
 *                referenced by `indices[i]` are treated as NaN (sort to tail
 *                in stable order).
 * @param indices the index buffer to reorder in place. Each element is an
 *                index into `keys`; on return, `keys[indices[i]]` is
 *                non-decreasing as `i` grows. The buffer (including its
 *                underlying ArrayBuffer + byteOffset / length) is mutated in
 *                place — no re-allocation, callers can hold the reference.
 *
 * @example
 *   const keys = new Float64Array([3.1, 1.2, 2.7]);
 *   const idx = new Int32Array([0, 1, 2]);
 *   argsortInPlace(keys, idx); // idx -> [1, 2, 0]
 */
export function argsortInPlace(keys: Float64Array, indices: Int32Array): void {
  const n = indices.length;
  if (n <= 1) return;
  ensureArgsortCapacity(n);
  const kLo = argsortKeyLo;
  const kHi = argsortKeyHi;
  const vIdx = argsortValueIdx;
  let pCur = argsortPosA;
  let pTmp = argsortPosB;
  const cnts = argsortCounts;
  const offs = argsortOffsets;

  const keyLen = keys.length;
  for (let i = 0; i < n; i++) {
    const idxVal = indices[i] as number;
    const k = idxVal >= 0 && idxVal < keyLen ? (keys[idxVal] as number) : Number.NaN;
    argsortKeyF64View[0] = k;
    let hi = argsortKeyU32View[1] as number;
    let lo = argsortKeyU32View[0] as number;
    // Normalise -0 to +0 before the sign-bit unsigned-monotonic flip so the
    // two zeros collapse to a single encoded value (without this step the
    // sortable-bits trick would land -0 just below +0 by ULP, breaking
    // stable equality across the zero crossing).
    if (lo === 0 && (hi & 0x7fffffff) === 0) {
      hi = 0;
    }
    if (hi & 0x80000000) {
      hi = ~hi >>> 0;
      lo = ~lo >>> 0;
    } else {
      hi = (hi ^ 0x80000000) >>> 0;
    }
    kLo[i] = lo;
    kHi[i] = hi;
    vIdx[i] = idxVal;
    pCur[i] = i;
  }

  // 11-bit radix LSD, 6 passes (64-bit key span; last pass is 9 bits):
  //   p0: kLo bits  0..10                 (mask 0x7FF, 2048 buckets)
  //   p1: kLo bits 11..21                 (mask 0x7FF)
  //   p2: kLo bits 22..31 + kHi bit 0     (mask 0x7FF, cross-word)
  //   p3: kHi bits  1..11                 (mask 0x7FF)
  //   p4: kHi bits 12..22                 (mask 0x7FF)
  //   p5: kHi bits 23..31                 (mask 0x1FF, 512 buckets)
  for (let pass = 0; pass < 6; pass++) {
    cnts.fill(0);
    if (pass === 0) {
      for (let i = 0; i < n; i++) {
        const w = (kLo[pCur[i] as number] as number) & ARGSORT_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    } else if (pass === 1) {
      for (let i = 0; i < n; i++) {
        const w = ((kLo[pCur[i] as number] as number) >>> 11) & ARGSORT_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    } else if (pass === 2) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = (((kLo[pi] as number) >>> 22) | ((kHi[pi] as number) << 10)) & ARGSORT_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    } else if (pass === 3) {
      for (let i = 0; i < n; i++) {
        const w = ((kHi[pCur[i] as number] as number) >>> 1) & ARGSORT_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    } else if (pass === 4) {
      for (let i = 0; i < n; i++) {
        const w = ((kHi[pCur[i] as number] as number) >>> 12) & ARGSORT_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const w = ((kHi[pCur[i] as number] as number) >>> 23) & ARGSORT_FINAL_MASK;
        cnts[w] = (cnts[w] as number) + 1;
      }
    }
    let acc = 0;
    const buckets = pass === 5 ? ARGSORT_FINAL_BUCKETS : ARGSORT_BUCKETS;
    for (let b = 0; b < buckets; b++) {
      offs[b] = acc;
      acc += cnts[b] as number;
    }
    if (pass === 0) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = (kLo[pi] as number) & ARGSORT_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    } else if (pass === 1) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = ((kLo[pi] as number) >>> 11) & ARGSORT_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    } else if (pass === 2) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = (((kLo[pi] as number) >>> 22) | ((kHi[pi] as number) << 10)) & ARGSORT_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    } else if (pass === 3) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = ((kHi[pi] as number) >>> 1) & ARGSORT_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    } else if (pass === 4) {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = ((kHi[pi] as number) >>> 12) & ARGSORT_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const pi = pCur[i] as number;
        const w = ((kHi[pi] as number) >>> 23) & ARGSORT_FINAL_MASK;
        const dst = offs[w] as number;
        offs[w] = dst + 1;
        pTmp[dst] = pi;
      }
    }
    const tmp = pCur;
    pCur = pTmp;
    pTmp = tmp;
  }
  for (let i = 0; i < n; i++) indices[i] = vIdx[pCur[i] as number] as number;
}
