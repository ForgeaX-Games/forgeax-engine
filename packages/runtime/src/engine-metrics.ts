// @forgeax/engine-runtime — EngineMetrics public API (feat-20260527-sprite-nineslice
// M4 / w16). A per-Renderer counter Map exposed through `renderer.metrics` so AI
// users observe runtime-time soft signals (e.g. nineslice scale too small,
// nineslice tile mode without sampler repeat) without parsing console.warn text
// or reaching into engine internals (charter F1 minimum surface, P3 machine-
// readable signals over text logs).
//
// Surface — three methods:
//
//   | Method                         | Purpose                                     |
//   |:-------------------------------|:--------------------------------------------|
//   | `increment(name)`              | Bump the counter for `name` by 1.           |
//   | `snapshot()`                   | Read all counters as an immutable object.   |
//   | `reset()`                      | Drop every counter (test isolation hook).   |
//
// Naming convention (charter P5 consistent abstraction): counter keys use a
// dot-delimited namespace `<feature>.<event>`. Two features own keys today:
//
//   - `nineslice.scale-too-small`           — Transform.scale below the four
//     corner anchors at draw time (AC-16, w17 end-to-end test).
//   - `nineslice.tile-needs-repeat-sampler` — sliceMode=1 (tile) bound to a
//     sampler whose addressMode is not `'repeat'`; the visual silently
//     degrades to clamp-stretch (D-9, w18 register-time soft-warn).
//   - `render.instancing.foldedDraws`        — feat-20260622-chunk-gpu-
//     instancing-sprite-tilemap M3 / D-3. Count of instanced drawIndexed
//     calls the fold operator emits this frame; one increment per non-
//     singleton head bucket retained after the M2 / w11 cap-fallback
//     filter. NOT entity count, NOT pre-filter bucket count. AI users
//     read it via `renderer.metrics.snapshot()['render.instancing.foldedDraws']`
//     to verify fold actually reduced draw count under mode-0 (LAYER_Z)
//     transparent sort. The key is exported as `FOLDED_DRAWS_METRIC_KEY`
//     from `render-system-fold.ts` (single source of truth — engine
//     calls increment via the helper, never the literal string).
//
// Multi-Renderer isolation (D-5 candidate 1): each Renderer instance owns its
// own EngineMetrics; counters from one renderer never bleed into another.
// `createRenderer.ts` constructs a fresh instance per call; tests that spin
// up multiple renderers can read each `renderer.metrics.snapshot()` in
// isolation.

/**
 * Per-Renderer metrics counter API. Backed by a `Map<string, number>`; reads
 * return a frozen plain object so external mutation never leaks back into the
 * registry (D-5 + R-2 mutation-resistance).
 *
 * Three methods cover the full surface:
 *
 *   const r = await createRenderer(canvas);
 *   // ... renderer hits some nineslice runtime soft-warn
 *   r.metrics.snapshot()['nineslice.scale-too-small'];   // -> number | undefined
 *
 *   r.metrics.increment('nineslice.scale-too-small');    // mutate counter
 *   r.metrics.reset();                                   // drop all counters
 *
 * Callers can `for (const k in renderer.metrics.snapshot())` to enumerate
 * fired events without knowing the namespace ahead of time.
 *
 * @remarks Closed namespace (charter P5):
 * - `nineslice.scale-too-small`
 * - `nineslice.tile-needs-repeat-sampler`
 * - `render.instancing.foldedDraws`
 */
export interface EngineMetrics {
  /**
   * Bump the counter for `name` by 1. Counters start at 0 implicitly; the
   * first `increment(name)` lands a 1 in the snapshot. Names are free-form
   * strings (no prior registration), so feat-local namespaces (e.g.
   * `nineslice.*`) coexist without coordination.
   */
  increment(name: string): void;
  /**
   * Read all counters as an immutable `Readonly<Record<string, number>>`.
   * The returned object is frozen — external mutation throws in strict mode
   * and is silently ignored otherwise. Snapshot-then-mutate is decoupled
   * from the registry: a later `increment` does not retroactively alter the
   * already-returned snapshot.
   */
  snapshot(): Readonly<Record<string, number>>;
  /**
   * Drop every counter back to 0 (counter rows physically removed). Provided
   * for test isolation and Inspector reset workflows; production code on
   * the hot path never calls this.
   */
  reset(): void;
}

/**
 * Default `EngineMetrics` implementation — a thin `Map<string, number>` with
 * the three-method surface bolted on. The map is private; readers consume
 * the snapshot accessor.
 *
 * @internal — instances are constructed by `createRenderer` and surfaced
 * through `Renderer.metrics`; AI users do not import this class directly.
 */
export class EngineMetricsImpl implements EngineMetrics {
  private readonly counters = new Map<string, number>();

  increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) {
      out[k] = v;
    }
    return Object.freeze(out);
  }

  reset(): void {
    this.counters.clear();
  }
}

/**
 * Fresh `EngineMetrics` factory; the only construction path used by
 * `createRenderer`. Keeping the constructor private (via the factory) leaves
 * room to swap the backing store without touching call sites.
 */
export function createEngineMetrics(): EngineMetrics {
  return new EngineMetricsImpl();
}
