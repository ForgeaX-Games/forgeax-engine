// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w3 — mode-gate (D-5).
//
// Drives the pure fold helper for the four transparent-sort modes:
//   mode 0 (LAYER_Z)   -> fold enabled; equal-key runs collapse to 1 bucket.
//   mode 1 (LAYER_Y)   -> bypass per-entity (per-cell footY differs structurally).
//   mode 2 (LAYER_YZ)  -> bypass per-entity (composite per-entity key).
//   mode 3 (DISTANCE)  -> bypass per-entity (per-entity camera distance).
//
// Bypass semantics: each DispatchEntry produces its own singleton bucket
// (bucketSize=1). The fold dispatcher (record-stage) treats singleton
// buckets identically to today's per-entity drawIndexed path; mode 1/2/3
// therefore produce N draws for N entries, identical to current behavior
// (charter P3 silent fallback — no error, no warning).
//
// Constraints from plan-strategy D-5: mode 0 is the only fold-enabled
// mode; this is the only place that gate is exercised at unit-test scope.

import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { DispatchEntry } from '../render-system-extract';
import { foldDispatchBuckets } from '../render-system-fold';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../systems/transparent-sort-config';

function mockEntry(opts: {
  renderableIndex: number;
  materialHandle: number;
  layer: number;
}): DispatchEntry {
  return {
    entityIndex: opts.renderableIndex,
    materialHandle: opts.materialHandle,
    renderableIndex: opts.renderableIndex,
    passIndex: 0,
    queue: RenderQueue.Transparent,
    layer: opts.layer,
    tags: {},
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
    paramSnapshot: undefined,
  };
}

function mockRenderable(tz: number): {
  transform: { world: Float32Array };
  material: { shadingModel: 'unlit' | 'sprite' | undefined };
} {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[14] = tz;
  // PR #502 fix: 'sprite' preserves the fold-eligible behavior these
  // mode-gate tests exercise (mode-0 should fold, mode-1/2/3 should
  // bypass per-entity); see render-system-fold.ts sprite-pass-only gate.
  return { transform: { world }, material: { shadingModel: 'sprite' } };
}

describe('foldDispatchBuckets — mode-gate (D-5, w3)', () => {
  // 5 entries all sharing (layer=0, posZ=0, materialHandle=1).
  // Under mode 0 they collapse to 1 bucket. Under mode 1/2/3 they each
  // get their own singleton bucket (bypass).
  function makeUniformInputs(N: number): {
    entries: DispatchEntry[];
    renderables: ReturnType<typeof mockRenderable>[];
  } {
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 1, layer: 0 }));
      renderables.push(mockRenderable(0));
    }
    return { entries, renderables };
  }

  it('mode 0 (LAYER_Z) — N equal-key entries collapse to 1 bucket', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(1);
    const b = buckets[0];
    expect(b).toBeDefined();
    if (b === undefined) return;
    expect(b.bucketSize).toBe(5);
  });

  it('mode 1 (LAYER_Y) — N entries bypass to N singleton buckets (no fold)', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode 2 (LAYER_YZ) — N entries bypass to N singleton buckets (no fold)', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_YZ, renderables);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode 3 (DISTANCE) — N entries bypass to N singleton buckets (no fold)', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_DISTANCE, renderables);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode-gate is silent: bypass modes do not throw or fire errors', () => {
    const { entries, renderables } = makeUniformInputs(3);
    // The pure helper does not have access to errorRegistry; "silent"
    // here means no thrown exception. Negative-space assertion.
    expect(() =>
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables),
    ).not.toThrow();
    expect(() =>
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_YZ, renderables),
    ).not.toThrow();
    expect(() =>
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_DISTANCE, renderables),
    ).not.toThrow();
  });
});
