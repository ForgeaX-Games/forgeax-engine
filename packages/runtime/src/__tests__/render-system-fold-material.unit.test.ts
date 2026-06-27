// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w2 — AC-10 multi-material.
//
// Drives the pure fold helper for the AC-10 boundary: a single chunk
// spanning multiple atlas/material handles. Same Layer.value + same posZ +
// 2 different materialHandle values must produce 2 separate buckets — the
// fold must NOT merge them into one bucket (would render with the wrong
// texture, requirements AC-10).
//
// Bucket key is the three-tuple (Layer.value, posZ, materialHandle). The
// fold's correctness on the materialHandle leg is what this test pins.

import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { DispatchEntry } from '../render-system-extract';
import { foldDispatchBuckets } from '../render-system-fold';
import { TRANSPARENT_SORT_MODE_LAYER_Z } from '../systems/transparent-sort-config';

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
  // material-keyed tests exercise.
  return { transform: { world }, material: { shadingModel: 'sprite' } };
}

describe('foldDispatchBuckets — AC-10 multi-material boundary (w2)', () => {
  it('2 different materialHandle values with same (layer, posZ) -> 2 separate buckets', () => {
    // Layout (ordered by mode-0 sort which is stable within (layer, posZ)):
    // [M1, M1, M1, M2, M2] — 3 entries with materialHandle=11 followed by
    // 2 with materialHandle=22, all same layer=5 and same posZ=3.0.
    const entries: DispatchEntry[] = [
      mockEntry({ renderableIndex: 0, materialHandle: 11, layer: 5 }),
      mockEntry({ renderableIndex: 1, materialHandle: 11, layer: 5 }),
      mockEntry({ renderableIndex: 2, materialHandle: 11, layer: 5 }),
      mockEntry({ renderableIndex: 3, materialHandle: 22, layer: 5 }),
      mockEntry({ renderableIndex: 4, materialHandle: 22, layer: 5 }),
    ];
    const renderables: ReturnType<typeof mockRenderable>[] = [
      mockRenderable(3.0),
      mockRenderable(3.0),
      mockRenderable(3.0),
      mockRenderable(3.0),
      mockRenderable(3.0),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(2);
    const b0 = buckets[0];
    const b1 = buckets[1];
    expect(b0).toBeDefined();
    expect(b1).toBeDefined();
    if (b0 === undefined || b1 === undefined) return;
    expect(b0.materialHandle).toBe(11);
    expect(b0.bucketSize).toBe(3);
    expect(b1.materialHandle).toBe(22);
    expect(b1.bucketSize).toBe(2);
  });

  it('2 material runs interleaved (M1, M2, M1, M2) -> 4 separate singleton buckets (no string-bucket bug)', () => {
    // The fold operator walks consecutive runs only; non-consecutive
    // entries of the same material must NOT be merged into one bucket
    // (would re-order draws, breaking transparent-sort stability).
    const entries: DispatchEntry[] = [
      mockEntry({ renderableIndex: 0, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 1, materialHandle: 22, layer: 0 }),
      mockEntry({ renderableIndex: 2, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 3, materialHandle: 22, layer: 0 }),
    ];
    const renderables: ReturnType<typeof mockRenderable>[] = [
      mockRenderable(0),
      mockRenderable(0),
      mockRenderable(0),
      mockRenderable(0),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    // 4 singleton buckets — consecutive-run fold preserves stable ordering.
    expect(buckets).toHaveLength(4);
    for (const b of buckets) {
      expect(b.bucketSize).toBe(1);
    }
  });

  it('two-material run with material key as bucket discriminator: distinct material -> never merged', () => {
    // Edge: same layer + same posZ + different materialHandle. Even if
    // (layer, posZ) match, materialHandle is the third key dimension and
    // must split the bucket. This is the AC-10 essence (multi-atlas chunk).
    const entries: DispatchEntry[] = [
      mockEntry({ renderableIndex: 0, materialHandle: 100, layer: 9 }),
      mockEntry({ renderableIndex: 1, materialHandle: 200, layer: 9 }),
    ];
    const renderables: ReturnType<typeof mockRenderable>[] = [
      mockRenderable(4.0),
      mockRenderable(4.0),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(2);
    const b0 = buckets[0];
    const b1 = buckets[1];
    expect(b0).toBeDefined();
    expect(b1).toBeDefined();
    if (b0 === undefined || b1 === undefined) return;
    expect(b0.materialHandle).toBe(100);
    expect(b1.materialHandle).toBe(200);
    expect(b0.bucketSize).toBe(1);
    expect(b1.bucketSize).toBe(1);
  });
});
