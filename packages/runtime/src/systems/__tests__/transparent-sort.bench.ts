// transparent-sort.bench.ts -- transparent-bucket sort 10k-entity p95 gate
// (feat-20260520-2d-sprite-layer-mvp / M-4 / w27; AC-14).
//
// Scope (3 cases x 100 iterations each):
//   - mode=0 layer-z   (horizontal side-scroller; sortValue = posZ)
//   - mode=1 layer-y   (JRPG Y-sort foot pivot; sortValue = -(posY - pivotY * sizeY))
//   - mode=2 layer-yz  (Don't-Starve / isometric blend;
//                        sortValue = (posY - pivotY * sizeY) + yzAlpha * posZ)
//
// AC-14 contract (3 reproducibility anchors):
//   1. deterministic seed via `createXorshift32(0xCAFE2026)` so the
//      bench number is a function of the algorithm, not the test data
//      (w26 + plan-strategy D-3 SSOT, zero npm dep).
//   2. >= 100 iterations -> tinybench reports a stable p95 across the
//      whole sample window; `BENCH_OPTS_RUNTIME` pins iterations: 100
//      so KUBEELA_BENCH=fast does not silently shrink the sample below
//      the AC floor.
//   3. Working baseline (implementation phase, R1 F-2 audit trail):
//      p95 ~ 3 ms / 10k entities on GitHub Actions ubuntu-latest 6 vCPU.
//      Root cause is V8 closure overhead in Array.prototype.sort + JS
//      comparator (10k * log2(10k) ~ 140k comparator invocations per
//      iteration; each crosses the JS<->C++ bridge ~ 20-30 ns).
//      package.json forgeax.metrics.bench.baseline.threshold = 5 ms
//      (5_000_000 ns/op) tracks this working baseline.
//
//      plan-strategy §2 D-3's 0.5 ms p95 target is DEFERRED to
//      `feat-future-transparent-sort-radix` (todos.json todo-140).
//      The future algorithm rewrite (composite-key BigInt64Array.sort
//      over `(layer << 32) | (sortValueQuantizedInt32 ^ 0x80000000)`,
//      or a radix sort over the same packed int64) replaces the JS
//      comparator with a typed-array sort that stays inside C++ and
//      should clear the 0.5 ms bar. Until that lands, the bench guards
//      the 5 ms working ceiling — a regression past 5 ms still fails
//      `pnpm metrics:run` and surfaces a real perf cliff.
//
//      Closed-loop trail: ImplementReviewer R1 F-2 (judged "defer +
//      todo + JSDoc audit trail") in
//      `.forgeax-harness/forgeax-loop/feat-20260520-2d-sprite-layer-
//      mvp/implement-review.md` §5 closes here.
//
// Fixture shape (10k entries; structurally identical to a real M-4 record
// stage transparent bucket but with synthetic numbers):
//   - layer    ~ uniform i32 in [-1000, 1000]
//   - posX/Y/Z ~ uniform f64 in [0, 100)
//   - pivotY   ~ uniform f64 in [0, 1]   (matches SpriteMaterialAsset.pivot[1] range)
//   - sizeY    ~ uniform f64 in [0.5, 2] (matches world-scale-ish sprites)
//   - sortKey  -- undefined for the base bench; the AC-14 measurement
//                 does NOT inject overrides because the comparator must
//                 evaluate the mode formula for every entry to measure
//                 the worst case.
//
// Anchor: requirements §3 AC-14 + plan-strategy §2 D-3 / §5.4 verdict
// gate / §7 M-4 acceptanceCheck. The active threshold SSOT lives in
// packages/runtime/package.json#forgeax.metrics.bench.baseline.threshold
// (5_000_000 ns/op working baseline; R1 F-2 defer note above).

import { World } from '@forgeax/engine-ecs';
import { bench, describe } from 'vitest';

import type { TransparentEntry } from '../transparent-sort';
import { transparentSortEntries } from '../transparent-sort';
import {
  setTransparentSortConfig,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../transparent-sort-config';
import { createXorshift32 } from './_xorshift';

// AC-14 sample size + iterations (plan-strategy D-3 SSOT). Vitest 4.x
// forwards `iterations` straight to tinybench so the p95 statistic is
// computed from a >= 100-sample window.
const N_ENTITIES = 10_000;
const BENCH_OPTS_RUNTIME = { iterations: 100 } as const;

// Build the synthetic fixture once outside the bench body so allocation
// cost stays out of the comparator-loop hot path (the math bench files
// use the same closure pattern via vec3.create(...) above the bench
// block). The same fixture is shared across all 3 mode benches so a
// regression in one mode is directly comparable to the others.
function buildEntries(): readonly TransparentEntry[] {
  const rng = createXorshift32(0xcafe2026);
  const out: TransparentEntry[] = new Array(N_ENTITIES);
  for (let i = 0; i < N_ENTITIES; i++) {
    const layer = Math.floor(rng() * 2001) - 1000;
    out[i] = {
      entityIndex: i,
      materialHandle: 1024 + (i % 256),
      layer,
      posX: rng() * 100,
      posY: rng() * 100,
      posZ: rng() * 100,
      pivotY: rng(),
      sizeY: 0.5 + rng() * 1.5,
    };
  }
  return out;
}

const ENTRIES = buildEntries();

// Separate RNG for the mode=3 bench so the camera position does not
// consume entropy from the entry pool. A second entries fixture with
// a different seed avoids JIT-coupling the mode=3 bench noise to the
// mode=0/1/2 bench noise.
function buildEntriesDist(): readonly TransparentEntry[] {
  const rng = createXorshift32(0x2dda7a6e);
  const out: TransparentEntry[] = new Array(N_ENTITIES);
  for (let i = 0; i < N_ENTITIES; i++) {
    const layer = Math.floor(rng() * 2001) - 1000;
    out[i] = {
      entityIndex: i,
      materialHandle: 1024 + (i % 256),
      layer,
      posX: rng() * 100,
      posY: rng() * 100,
      posZ: rng() * 100,
      pivotY: rng(),
      sizeY: 0.5 + rng() * 1.5,
    };
  }
  return out;
}

const ENTRIES_DIST = buildEntriesDist();

// independent RNG for per-iteration camera positions
const rngDist = createXorshift32(0x9a88_e5b3);

function makeWorld(mode: number): World {
  const world = new World();
  const r = setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
  if (!r.ok) {
    // Should be unreachable -- the three constants are by construction
    // members of the valid {0, 1, 2} set. If this fires the fixture
    // setup is broken at the harness level; bail loudly so a bench
    // regression report is not silently meaningless.
    throw new Error(`[transparent-sort.bench] setTransparentSortConfig failed: ${r.error.code}`);
  }
  return world;
}

describe('transparent-sort 10k entities', () => {
  const worldZ = makeWorld(TRANSPARENT_SORT_MODE_LAYER_Z);
  const worldY = makeWorld(TRANSPARENT_SORT_MODE_LAYER_Y);
  const worldYZ = makeWorld(TRANSPARENT_SORT_MODE_LAYER_YZ);
  const worldDist = makeWorld(3);
  // Sink pattern (wiki/vitest-bench section 7.1): forces JIT to keep the
  // sort result reachable; an unread return value is a dead-store
  // candidate and the optimiser may then short-circuit the comparator
  // visits inside Array.prototype.sort. The `_sink` prefix tags it
  // explicitly as "write-only inside the loop, read once at teardown"
  // so biome's noUnusedVariables rule does not flag it (we DO read it
  // once below to satisfy lint + keep V8 from dead-storing).
  let _sink = 0;

  bench(
    'mode=0 layer-z (horizontal)',
    () => {
      const out = transparentSortEntries(ENTRIES, worldZ);
      // `?.entityIndex ?? 0` keeps the read total under
      // noUncheckedIndexedAccess; `| 0` is the canonical int32 sink.
      _sink ^= (out[0]?.entityIndex ?? 0) | 0;
    },
    BENCH_OPTS_RUNTIME,
  );

  bench(
    'mode=1 layer-y (JRPG)',
    () => {
      const out = transparentSortEntries(ENTRIES, worldY);
      _sink ^= (out[0]?.entityIndex ?? 0) | 0;
    },
    BENCH_OPTS_RUNTIME,
  );

  bench(
    "mode=2 layer-yz (isometric / Don't-Starve)",
    () => {
      const out = transparentSortEntries(ENTRIES, worldYZ);
      _sink ^= (out[0]?.entityIndex ?? 0) | 0;
    },
    BENCH_OPTS_RUNTIME,
  );

  // ─── w3: mode=3 distance bench (TDD red phase) ─────────────────────

  // Red: setTransparentSortConfig rejects mode=3 (not yet in VALID_MODES).
  // When green, the extra cost of 3 squared-distance ops per entry should
  // add <0.05ms vs the ~3ms p95 baseline on 10k entries (research E4(c)).

  bench(
    'mode=3 distance (back-to-front squared-distance)',
    () => {
      const cameraPos: readonly [number, number, number] = [
        rngDist() * 100,
        rngDist() * 100,
        rngDist() * 100,
      ];
      // Red: 3-arg signature does not exist yet; cast bridges the red gap.
      const out = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )(ENTRIES_DIST, worldDist, cameraPos);
      _sink ^= (out[0]?.entityIndex ?? 0) | 0;
    },
    BENCH_OPTS_RUNTIME,
  );

  // Single teardown-time read keeps `_sink` from being a strict
  // write-only target (lint + JIT both observe the value); the read
  // path lives inside an arrow predicate so tinybench's harness
  // never invokes it during the measurement window. Sink pattern
  // (wiki/vitest-bench section 7.1).
  void [() => _sink];
});
