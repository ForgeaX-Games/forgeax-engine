// @forgeax/engine-runtime — fold operator (record-stage transparent fold).
//
// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 — pure helper.
// feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w11 — uniform-cap
// fallback decision helper (`evaluateFoldBucketUniformCap`).
//
// Plan-strategy D-1 (record-stage transparent fold) + D-5 (mode-gate, only
// LAYER_Z folds) + D-7 (bucket key reuses transparent-sort equivalence
// class — no new BinKey type). The helper takes a transparent-sort-ordered
// DispatchEntry[] and groups consecutive entries with equal three-tuple
// (Layer.value, posZ, materialHandle) into FoldBucket descriptors.
//
// The bucket carries an assembled Float32Array of per-instance world mat4s
// (stride=16, column-major), suitable for upload to a GPU instance buffer
// and a single drawIndexed(indexCount, bucketSize) call. The actual
// recordFrame integration (instance buffer upload + drawIndexed swap) is
// the consumer's responsibility — this file is pure data shaping, no GPU
// dependencies, fully unit-testable.
//
// Mode-gate (D-5):
//   - mode 0 (LAYER_Z): runs collapse — chunk-level GPU instancing.
//   - mode 1 (LAYER_Y) / 2 (LAYER_YZ) / 3 (DISTANCE): bypass per-entity —
//     each entry becomes a singleton bucket (bucketSize=1). The dispatch
//     consumer treats singleton buckets identically to today's per-entity
//     drawIndexed, so the bypass is byte-for-byte the current behavior
//     (charter P3 silent fallback — no error fired, AC-04 zero-difference
//     for sortScope modes preserved).
//
// Uniform-cap fallback (M2 / D-2 + D-9):
//   - When `caps.storageBuffer === false` (WebGL2 path) AND a fold bucket
//     carries more than `FOLD_UNIFORM_INSTANCE_CAP = 128` instances, the
//     bucket cannot fit a uniform-buffer binding (research N-1: 128 * 64 B
//     mat4 stride = 8192 B fits inside the WebGL2 minimum 16384 B UBO size
//     with headroom; 256 instances * 64 B = 16384 B would not). The
//     pure-helper `evaluateFoldBucketUniformCap(bucket, caps, scope)`
//     answers the dispatch site's "should this bucket fold or fall back?"
//     question with a `{ fallback, error? }` POD. The record-stage
//     consumer (`render-system-record.ts`) fires `error` AND routes the
//     bucket through the same per-entity drawIndexed exit the mode-gate
//     bypass uses (plan-strategy D-9 "shared fallback exit") so the
//     frame stays visually correct (no identity-collapse / black screen).
//
// AC-08: this file lives outside packages/runtime/src/scene-instances/
// (skin-joint post-spawn semantics, unrelated to GPU-instancing folding).

import { RhiError } from '@forgeax/engine-rhi';
import type { DispatchEntry } from './render-system-extract';
import {
  TRANSPARENT_SORT_MODE_LAYER_Z,
  type TransparentSortConfig,
} from './systems/transparent-sort-config';

/**
 * Per-bucket descriptor produced by {@link foldDispatchBuckets}.
 *
 * One bucket = one fold-eligible run of consecutive DispatchEntry whose
 * `(layer, posZ, materialHandle)` triple is equal. Singleton buckets
 * (bucketSize=1) appear when the mode bypasses fold (D-5 mode != 0) or
 * when consecutive entries differ in any of the three keys.
 *
 * Fields:
 *   - `entries` — original DispatchEntry slice for this bucket (preserves
 *     the input ordering); the consumer uses these to look up per-entity
 *     material BG handles, mesh handles (which are bucket-uniform by
 *     construction since materialHandle key is included), etc.
 *   - `bucketSize` — `entries.length`. Surfaced as a top-level field so
 *     the consumer can pass it directly as `instanceCount` to
 *     `drawIndexed`.
 *   - `transforms` — assembled Float32Array of bucketSize world mat4s,
 *     stride=16 floats per instance, column-major. Suitable for direct
 *     `device.queue.writeBuffer` into an instance buffer used at @group(3).
 *   - `materialHandle` / `layer` / `posZ` — the three-tuple key for this
 *     bucket; consumed by the dispatch loop for bind-group selection /
 *     sort-stability invariants.
 */
export interface FoldBucket {
  readonly entries: readonly DispatchEntry[];
  readonly bucketSize: number;
  readonly transforms: Float32Array;
  readonly materialHandle: number;
  readonly layer: number;
  readonly posZ: number;
}

/**
 * Minimal renderable shape consumed by the helper. The real
 * `RenderableSnapshot` carries many more fields; the helper only reads
 * `transform.world` (a Float32Array of 16 column-major floats) and
 * `material.transparent` (the LDR-split-sub-pass fold gate, see PR #502
 * fix + feat-20260625 R2 fix-up: geometry-pass entities — non-transparent
 * materials — MUST stay singleton because the sprite-pass dispatch path
 * that consumes `headBuckets` does not run for them; folding them would
 * overwrite their mesh-SSBO slot with identity and collapse 3D geometry
 * to origin).
 *
 * Production callers pass `RenderableSnapshot[]` straight through —
 * `RenderableSnapshot.material.transparent` is `boolean | undefined`
 * (derived by the extract stage from `passes[0].renderState.blend !==
 * undefined`, the post-feat-20260626-collapse SSOT; see
 * `MaterialSnapshot.transparent`), structurally compatible with this
 * minimal shape. The gate read inside the helper uses `=== true` /
 * `!== true` so both `false` and `undefined` enter the singleton branch.
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: gate
 * migrated from `shadingModel === 'sprite'` (the union member was
 * removed in M3 / w15) to `transparent === true` (the new SSOT for
 * "routes through the LDR split sub-pass" — same predicate the
 * `splitLdrSprite` filter at render-system-record.ts:4826/5612 uses).
 */
export interface FoldRenderableLike {
  readonly transform: { readonly world: Float32Array };
  readonly material: { readonly transparent?: boolean | undefined };
}

/**
 * Linear-scan fold operator (plan-strategy D-1).
 *
 * Walks `orderedEntries` (must be transparent-sort-ordered when mode=0;
 * the helper trusts the input ordering and only checks adjacent equality
 * — non-consecutive entries with equal keys are NOT merged, preserving
 * stable-sort semantics).
 *
 * @param orderedEntries — DispatchEntry[] in transparent-sort order. Empty
 *   array yields zero buckets (defensive empty-bucket suppression).
 * @param mode — current `TransparentSortConfig.mode`. Only mode 0
 *   (LAYER_Z) enables fold; other modes produce singleton buckets per
 *   entry (D-5).
 * @param renderables — parallel snapshot array indexed by
 *   `DispatchEntry.renderableIndex`. The helper reads `transform.world`
 *   to (a) extract `posZ` (index 14 of the world mat4) for the bucket
 *   key, and (b) copy 16 floats per entry into the assembled transforms
 *   buffer. Out-of-range / missing renderables defensively contribute a
 *   zero mat4 slot (consumer-visible, but never generated by the
 *   production extract path).
 * @returns Array of FoldBucket descriptors in input order.
 */
export function foldDispatchBuckets(
  orderedEntries: readonly DispatchEntry[],
  mode: TransparentSortConfig['mode'],
  renderables: readonly FoldRenderableLike[],
): readonly FoldBucket[] {
  if (orderedEntries.length === 0) return [];

  // Bypass branch (D-5): mode != 0 cannot fold structurally, each entry
  // produces its own singleton bucket. The dispatch consumer treats
  // bucketSize=1 identically to today's per-entity drawIndexed — byte-
  // identical behavior, no error fired (charter P3 silent fallback).
  if (mode !== TRANSPARENT_SORT_MODE_LAYER_Z) {
    const out: FoldBucket[] = [];
    for (let i = 0; i < orderedEntries.length; i++) {
      const e = orderedEntries[i];
      if (e === undefined) continue;
      out.push(makeSingletonBucket(e, renderables));
    }
    return out;
  }

  // Fold branch (mode 0 = LAYER_Z): linear scan, collect runs with equal
  // (layer, posZ, materialHandle).
  //
  // Transparent-pass-only gate (PR #502 fix + feat-20260625 R2 fix-up):
  // the only dispatch site that consumes `headBuckets` to emit one
  // instanced drawIndexed per bucket is the transparent-pass loop in
  // `render-system-record.ts` (~line 5500; routed via `splitLdrSprite`
  // filter on `material.transparent === true`). The geometry-pass loop
  // (~line 4660) iterates `validatedOrdered` and emits per-entity
  // drawIndexed unchanged; it does NOT branch on `headBuckets`. So when
  // a non-transparent entry (geometry-pass: unlit / standard-PBR / skin)
  // is folded into a multi-entry bucket, the mesh-SSBO upload loop
  // (~line 2710) still overwrites its mesh slot with identity (because
  // `headBuckets.has(i)` is true), but the geometry-pass then reads
  // identity and renders the 3D geometry at the origin — collapsing the
  // frame to black (hello-room CI regression).
  //
  // Concept-count fix: encode "fold is transparent-sub-pass-only" at the
  // head selection point — the gate is the single bucket-key invariant
  // that makes both dispatch sites correct without coupling identity-
  // overwrite logic to a separate check (avoiding the D-9 shared-exit
  // violation that selecting fix-location B would produce).
  //
  // Non-transparent entries (`transparent !== true`) always produce
  // singleton buckets (bucketSize=1), which `buildFoldDispatchPlan`
  // filters out (`if (bucket.bucketSize <= 1) continue`), so they never
  // enter `headBuckets` / `skipIndices` — the mesh-SSBO upload,
  // transparent-pass, and geometry-pass loops all see them as byte-
  // identical to the pre-fold per-entity path.
  //
  // feat-20260625 R2 fix-up: pre-feat the gate was `shadingModel ===
  // 'sprite'`; M3 / w15 narrowed the shadingModel union to
  // `'unlit' | undefined` (the `'sprite'` discriminator was the design
  // ablation target), so the gate now reads `material.transparent` —
  // the new SSOT for "routes through the LDR split sub-pass" mirrored
  // on `computeSplitLdrSprite` + the `splitLdrSprite` skip filter.
  const buckets: FoldBucket[] = [];
  let runStart = 0;
  while (runStart < orderedEntries.length) {
    const head = orderedEntries[runStart];
    if (head === undefined) {
      runStart += 1;
      continue;
    }
    // Transparent-pass-only gate (feat-20260625 R2 fix-up): non-transparent
    // heads emit a singleton bucket and advance the cursor by 1 — no run
    // extension. `RenderableSnapshot.material.transparent` is the SSOT
    // carrier (extract stage derives it from the first pass's
    // `renderState.blend !== undefined`, post-feat-20260626-collapse;
    // see `MaterialSnapshot.transparent`).
    const headTransparent = renderables[head.renderableIndex]?.material.transparent;
    if (headTransparent !== true) {
      buckets.push(makeSingletonBucket(head, renderables));
      runStart += 1;
      continue;
    }
    const headPosZ = readPosZ(head.renderableIndex, renderables);
    let runEnd = runStart + 1;
    while (runEnd < orderedEntries.length) {
      const cand = orderedEntries[runEnd];
      if (cand === undefined) break;
      if (cand.layer !== head.layer) break;
      if (cand.materialHandle !== head.materialHandle) break;
      // Defensive: cand transparent must also be true to join the run.
      // Same materialHandle implies same transparent flag in production
      // (material asset identity), but the check costs O(1) per cand and
      // makes the bucket invariant locally readable.
      const candTransparent = renderables[cand.renderableIndex]?.material.transparent;
      if (candTransparent !== true) break;
      const candPosZ = readPosZ(cand.renderableIndex, renderables);
      if (candPosZ !== headPosZ) break;
      runEnd += 1;
    }

    const run = orderedEntries.slice(runStart, runEnd);
    const transforms = assembleTransforms(run, renderables);
    buckets.push({
      entries: run,
      bucketSize: run.length,
      transforms,
      materialHandle: head.materialHandle,
      layer: head.layer,
      posZ: headPosZ,
    });
    runStart = runEnd;
  }
  return buckets;
}

function makeSingletonBucket(
  entry: DispatchEntry,
  renderables: readonly FoldRenderableLike[],
): FoldBucket {
  const transforms = new Float32Array(16);
  const w = renderables[entry.renderableIndex]?.transform.world;
  if (w !== undefined) transforms.set(w);
  const posZ = (w?.[14] ?? 0) as number;
  return {
    entries: [entry],
    bucketSize: 1,
    transforms,
    materialHandle: entry.materialHandle,
    layer: entry.layer,
    posZ,
  };
}

function assembleTransforms(
  run: readonly DispatchEntry[],
  renderables: readonly FoldRenderableLike[],
): Float32Array {
  const out = new Float32Array(run.length * 16);
  for (let i = 0; i < run.length; i++) {
    const e = run[i];
    if (e === undefined) continue;
    const w = renderables[e.renderableIndex]?.transform.world;
    if (w !== undefined) out.set(w, i * 16);
  }
  return out;
}

function readPosZ(renderableIndex: number, renderables: readonly FoldRenderableLike[]): number {
  const w = renderables[renderableIndex]?.transform.world;
  if (w === undefined) return 0;
  return (w[14] ?? 0) as number;
}

/**
 * Per-validatedOrdered-index fold metadata consumed by the record-stage
 * dispatch loops. Built from {@link foldDispatchBuckets} output by
 * {@link buildFoldDispatchPlan}; see plan-strategy §3.2 sequence diagram.
 *
 * Field semantics (consumer contract, w4-record-swap):
 *   - `headBuckets[i]` is non-null when validatedOrdered index `i` is the
 *     **bucket head** of a non-singleton (bucketSize > 1) fold bucket. The
 *     dispatch loop overrides @group(3) instances BG to a transient buffer
 *     holding `bucket.transforms` and emits `drawIndexed(idxCount,
 *     bucket.bucketSize)` instead of per-entity drawIndexed.
 *   - `skipIndices.has(i)` is true when index `i` is a non-head member of
 *     a non-singleton fold bucket; the dispatch loop emits `continue`.
 *   - Singleton buckets (bucketSize === 1) leave both arrays empty for
 *     that index — dispatch falls through to the existing per-entity path
 *     byte-identically (mode-bypass / non-foldable head / fold-disabled).
 *
 * Note: the maps are keyed on `validatedOrderedIndex`, NOT
 * `renderableIndex`. The dispatch loops iterate `validatedOrdered` by
 * positional index `i`, and that index drives mesh SSBO slot offset
 * (`i * MESH_PER_ENTITY_STRIDE`), material UBO slot, and per-entity bind
 * group cache keys, all of which the swap must coordinate with.
 */
export interface FoldDispatchPlan {
  readonly headBuckets: ReadonlyMap<number, FoldBucket>;
  readonly skipIndices: ReadonlySet<number>;
  readonly foldedBucketCount: number;
}

/**
 * Build the per-validatedOrdered-index fold metadata from a
 * {@link foldDispatchBuckets} output.
 *
 * @param buckets — output of {@link foldDispatchBuckets}; ordered by
 *   transparent-sort scan order.
 * @param renderableIndexToValidatedIndex — map from `DispatchEntry.renderableIndex`
 *   to the validated-ordered index `i` (the loop counter the dispatch
 *   loops use). Caller builds this once per frame from `validatedOrdered`.
 * @returns FoldDispatchPlan keyed by validated-ordered index.
 *
 * Empty / all-singleton input yields empty maps + `foldedBucketCount=0`,
 * which the dispatch loops treat as "no fold this frame" — byte-identical
 * to pre-feat behavior.
 */
export function buildFoldDispatchPlan(
  buckets: readonly FoldBucket[],
  renderableIndexToValidatedIndex: ReadonlyMap<number, number>,
): FoldDispatchPlan {
  const headBuckets = new Map<number, FoldBucket>();
  const skipIndices = new Set<number>();
  let foldedBucketCount = 0;
  for (const bucket of buckets) {
    if (bucket.bucketSize <= 1) continue;
    const headEntry = bucket.entries[0];
    if (headEntry === undefined) continue;
    const headValidatedIdx = renderableIndexToValidatedIndex.get(headEntry.renderableIndex);
    if (headValidatedIdx === undefined) continue;
    headBuckets.set(headValidatedIdx, bucket);
    foldedBucketCount += 1;
    for (let i = 1; i < bucket.entries.length; i++) {
      const memberEntry = bucket.entries[i];
      if (memberEntry === undefined) continue;
      const memberValidatedIdx = renderableIndexToValidatedIndex.get(memberEntry.renderableIndex);
      if (memberValidatedIdx === undefined) continue;
      skipIndices.add(memberValidatedIdx);
    }
  }
  return { headBuckets, skipIndices, foldedBucketCount };
}

/**
 * WebGL2 uniform-fallback per-bucket instance-count ceiling
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / D-2 +
 * research N-1).
 *
 * 128 instances * 64 B/mat4 stride = 8192 B, comfortably below the WebGL2
 * minimum 16384 B UBO size, leaving headroom for the per-frame material
 * UBO slice. Locked at the type level via `RhiInstancingExceedsUniformCapDetail.limit`
 * (literal 128) — a future cap change would be a major evolution, not a
 * runtime knob.
 */
export const FOLD_UNIFORM_INSTANCE_CAP = 128;

/**
 * Minimal `RhiCapabilities` shape consumed by the cap-fallback helper.
 *
 * The real `RhiDevice.caps` carries many feature flags; the helper only
 * reads `storageBuffer` (the WebGL2 / WebGPU split signal — true on
 * WebGPU + dawn / wgpu native paths, false on the WebGL2 uniform-only
 * fallback path). Mirrors the field name on the production `RhiCaps`
 * type so the dispatch site can pass `runtime.device.caps` straight in.
 */
export interface FoldCapsLike {
  readonly storageBuffer: boolean;
}

/**
 * Decision POD returned by {@link evaluateFoldBucketUniformCap}.
 *
 * Fields:
 *   - `fallback` — `true` when the bucket must NOT fold and the dispatch
 *     site must route it through the per-entity drawIndexed exit (the
 *     same exit the mode-gate bypass uses, plan-strategy D-9 "shared
 *     fallback exit"). `false` when the bucket can fold normally.
 *   - `error` — the structured RhiError to fire alongside the fallback.
 *     Always populated when `fallback === true`; always `undefined` when
 *     `fallback === false` (charter proposition 4: explicit failure on
 *     the failure path; silent success on the success path).
 *
 * Caller contract: when `fallback === true`, fire the error via the
 * runtime error registry AND draw the bucket's entries individually
 * (each as a 1-instance drawIndexed). Skipping the fallback while still
 * firing the error would leave the frame visually wrong (uniform buffer
 * write would clip at 128 entries).
 */
export interface FoldBucketCapDecision {
  readonly fallback: boolean;
  readonly error: RhiError | undefined;
}

/**
 * Decide whether a fold bucket fits the WebGL2 uniform-fallback per-bucket
 * instance-count ceiling, returning the structured RhiError + fallback
 * intent the dispatch site needs to act on
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w11 +
 * plan-strategy D-2 + D-9 + AC-05).
 *
 * Decision matrix:
 *
 * | caps.storageBuffer | bucketSize  | fallback | error |
 * |:--|:--|:--|:--|
 * | `true`             | any         | `false`  | `undefined` (WebGPU has no per-binding instance cap inside the storage buffer's `maxStorageBufferBindingSize`; the byte-cap path emits `'limit-exceeded'` separately) |
 * | `false`            | `<= 128`    | `false`  | `undefined` (fits inside the WebGL2 minimum 16384 B UBO with headroom) |
 * | `false`            | `> 128`     | `true`   | `RhiError({ code: 'instancing-exceeds-uniform-cap', detail: { requested, limit: 128, scope } })` |
 *
 * Singleton buckets (`bucketSize === 1`) always pass — they are the
 * mode-gate bypass output and never need the cap check (the cap is
 * about *folded* bucket arity, not about per-entity per-frame work).
 *
 * @param bucket — the FoldBucket whose `bucketSize` is the sole input
 *   (instance count = bucketSize); other fields are not consulted.
 * @param caps — the runtime's RHI capability flags
 *   (`runtime.device.caps`); only `storageBuffer` is read.
 * @param scope — closed `'sprite' | 'tilemap-chunk'` discriminator the
 *   dispatch site picks based on the call site (sprite-pass primary
 *   sprite entry vs tilemap-chunk-derived entry). Surfaced verbatim on
 *   the error's `.detail.scope` so AI users can branch their recovery
 *   on which dispatch site overflowed.
 * @returns a {@link FoldBucketCapDecision} POD; never throws.
 */
export function evaluateFoldBucketUniformCap(
  bucket: FoldBucket,
  caps: FoldCapsLike,
  scope: 'sprite' | 'tilemap-chunk',
): FoldBucketCapDecision {
  if (caps.storageBuffer) return { fallback: false, error: undefined };
  if (bucket.bucketSize <= FOLD_UNIFORM_INSTANCE_CAP) {
    return { fallback: false, error: undefined };
  }
  const error = new RhiError({
    code: 'instancing-exceeds-uniform-cap',
    expected: `bucket instance count <= ${FOLD_UNIFORM_INSTANCE_CAP} (uniform fallback cap)`,
    hint: `reduce the bucket size (smaller layer/material groupings), switch to a WebGPU-capable backend (storage buffers lift the cap), or accept the per-cell drawIndexed fallback for ${scope}`,
    detail: {
      requested: bucket.bucketSize,
      limit: FOLD_UNIFORM_INSTANCE_CAP,
      scope,
    },
  });
  return { fallback: true, error };
}

/**
 * Closed metric key for the AC-06 fold counter
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / D-3).
 *
 * Semantics — count of instanced `drawIndexed` calls the fold operator
 * emits this frame; one increment per non-singleton head bucket retained
 * after the M2 / w11 cap-fallback filter. NOT entity count, NOT pre-
 * filter bucket count — cap-overrun buckets that the dispatch site
 * routed through the per-entity fallback exit do not count.
 *
 * Naming follows the EngineMetrics dot-namespace convention
 * (`<feature>.<event>`); `render.instancing.*` covers both sprite and
 * tilemap-chunk dispatch sites without scope ambiguity (research F-5,
 * plan-strategy §8.2). AI users observe via
 * `renderer.metrics.snapshot()['render.instancing.foldedDraws']`.
 */
export const FOLDED_DRAWS_METRIC_KEY = 'render.instancing.foldedDraws';

/**
 * Minimal `EngineMetrics` shape consumed by {@link incrementFoldedDrawsMetric}.
 *
 * The real `EngineMetrics` carries `snapshot()` + `reset()` too; the
 * helper only writes, so the consumed surface narrows to a single
 * method. Lets the unit test inject a `vi.fn()` mock without faking the
 * read APIs.
 */
export interface FoldMetricsLike {
  increment(name: string): void;
}

/**
 * Bump the AC-06 `render.instancing.foldedDraws` counter once per fold-
 * eligible head bucket in `plan` (M3 / w13, plan-strategy D-3).
 *
 * Single counter-write site for the metric — the record-stage consumer
 * calls this once per `recordFrame` after the cap-fallback filter
 * (M2 / w11) so cap-overrun buckets do not contribute (their members
 * fall through to per-entity drawIndexed, which is not an instanced
 * draw). `plan.foldedBucketCount` is the SSOT for "how many instanced
 * drawIndexed will this frame emit"; passing the same plan to this
 * helper keeps the metric and the actual dispatch in lockstep.
 *
 * Mode-bypass plans (D-5: mode != 0 yields singleton-only buckets which
 * `buildFoldDispatchPlan` filters out) carry `foldedBucketCount === 0`
 * and produce no increments — per-entity drawIndexed is not folded so
 * the metric correctly stays at 0.
 *
 * @param plan — output of {@link buildFoldDispatchPlan} after any
 *   cap-fallback filtering by the record-stage consumer.
 * @param metrics — the per-Renderer EngineMetrics counter; only
 *   `increment(name)` is called. Empty `plan.foldedBucketCount === 0`
 *   produces zero calls (no metric churn for fold-disabled frames).
 */
export function incrementFoldedDrawsMetric(plan: FoldDispatchPlan, metrics: FoldMetricsLike): void {
  for (let i = 0; i < plan.foldedBucketCount; i++) {
    metrics.increment(FOLDED_DRAWS_METRIC_KEY);
  }
}
