// propagate-transforms.dawn.test.ts -- vitest dawn project (AC-04) CPU-only
// propagateTransforms behaviour test.
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: node + setupFiles ./vitest.setup-webgpu.ts injects
//   globalThis.navigator.gpu (provided by dawn.node native binding).
//
// feat-20260601 M4: GlobalTransform is retired. propagateTransforms now writes
// the resolved world mat4 into the `Transform.world` column (column-major 16
// floats). Tests read that column via the ECS array view and assert the
// translation column (m[12,13,14]).
//
// Scope (w6 acceptanceCheck):
//   (a) root-only entity: Transform.world translation = local translation
//   (b) 2-level hierarchy: child.world = parent.world x child local
//   (c) stale ChildOf ref: Result.err(RhiError({ code: 'hierarchy-broken' }))
//   (d) N=3 deep chain: composition stacks correctly
//
// Although propagateTransforms is pure CPU code (no GPU access), the test is
// duplicated under the dawn layer so the AC-04 gate executes in both the
// browser GPU env and the dawn-node env -- matching plan-strategy §4 test
// matrix + requirements AC-04 two-layer coverage.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, TileLayer, Tilemap, Transform } from '../components/index';
import { propagateTransforms } from '../systems/propagate-transforms';

function identityTransformData() {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

// Read the resolved world mat4 (column-major 16 floats) from the Transform
// world column array view. Translation lives in column 3 (m[12,13,14]).
function worldOf(world: World, entity: EntityHandle): Float32Array {
  const view = (
    world as unknown as {
      _getArrayView(e: EntityHandle, c: typeof Transform, f: string): Float32Array | undefined;
    }
  )._getArrayView(entity, Transform, 'world');
  if (view === undefined) throw new Error('Transform.world view missing');
  return view;
}

describe('propagate-transforms.dawn - root-down DFS + stale ChildOf fail-fast (AC-04)', () => {
  it('root entity: Transform.world translation = local translation (identity chain)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [3, 4, 5],
          quat: [0, 0, 0, 1],
          scale: [2, 2, 2],
        },
      })
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const w = worldOf(world, root);
    expect(w.length).toBe(16);
    expect(w[12]).toBeCloseTo(3, 5);
    expect(w[13]).toBeCloseTo(4, 5);
    expect(w[14]).toBeCloseTo(5, 5);
    // Scale 2 lands on the diagonal of the rotation/scale 3x3 block.
    expect(w[0]).toBeCloseTo(2, 5);
  });

  it('2-level hierarchy: child.world = parent.world x child local (translation compose)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [10, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();
    const child = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [2, 3, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wc = worldOf(world, child);
    // parent translation (10,0,0) composed with child local translation
    // (2,3,0) and identity rotation/scale -> world position (12,3,0).
    expect(wc[12]).toBeCloseTo(12, 5);
    expect(wc[13]).toBeCloseTo(3, 5);
    expect(wc[14]).toBeCloseTo(0, 5);
    // Root world translation unaffected (identity chain writes).
    const wr = worldOf(world, root);
    expect(wr[12]).toBeCloseTo(10, 5);
  });

  it('N=3 deep hierarchy: grandchild position chains through two parent translations', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [1, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();
    const mid = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [2, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const leaf = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [4, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: mid } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wl = worldOf(world, leaf);
    // 1 + 2 + 4 = 7 along x-axis.
    expect(wl[12]).toBeCloseTo(7, 5);
  });

  // AC-07 (tweak-20260714-tilemap-layer-childed-render-entities M5): TileLayer
  // as an identity middle node must be transparent to propagateTransforms -- the
  // layer's Transform.world (16 f32) must equal its Tilemap parent's world mat4
  // byte-for-byte. This proves M1's coAttach injection produces a genuinely
  // identity TRS (pos=[0,0,0], quat=[0,0,0,1], scale=[1,1,1]) and the compose
  // (parent.world x identity) is a no-op in mat4 form.
  //
  // FALSIFY note (kept out of the test body per OOS-1 -- non-identity TileLayer
  // Transform is out of scope for this tweak): if the layer's Transform were
  // mutated to a non-identity value, propagateTransforms would compose it into
  // TileLayer.world and the byte-identity assertion below would fail. Not
  // asserted here because the M1 contract is precisely "identity default,
  // callers may override" -- the interesting invariant is transparency in the
  // default case.
  it('AC-07: identity TileLayer middle node -> Transform.world byte-identical to Tilemap parent', () => {
    const world = new World();
    // Parent Tilemap carries a non-identity translation so that the identity /
    // non-identity distinction is observable in the low three translation
    // slots of the 16-float world mat4.
    const tileset: TilesetAsset = {
      kind: 'tileset',
      guid: 'test/tileset-ac07',
      atlases: [toShared<'TextureAsset'>(1)],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    };
    const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      tileset,
    );
    const tilemap = world
      .spawn(
        {
          component: Tilemap,
          data: { cols: 1, rows: 1, tileSize: [1, 1], chunkSize: 16, tileset: tilesetHandle },
        },
        {
          component: Transform,
          data: {
            pos: [7, -3, 11],
            quat: [0, 0, 0, 1],
            scale: [2, 2, 2],
          },
        },
      )
      .unwrap();
    // TileLayer spawn -- caller supplies NO Transform. M1's coAttach injects
    // identity Transform automatically. This mirrors the demo spawn pattern
    // in apps/hello/tilemap/**, so AC-07 verifies the same code path AC-09
    // relies on.
    const layer = world
      .spawn(
        {
          component: TileLayer,
          data: {
            tiles: new Uint32Array([0]),
            layerOrder: 0,
            dirty: 1,
            sortScope: 0,
          },
        },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wTilemap = worldOf(world, tilemap);
    const wLayer = worldOf(world, layer);
    expect(wTilemap.length).toBe(16);
    expect(wLayer.length).toBe(16);
    // Byte-identical: identity middle node composes as a no-op. Direct index
    // comparison (not toBeCloseTo) is the tight assertion -- any floating-point
    // drift on identity compose would signal a real regression.
    for (let i = 0; i < 16; i++) {
      expect(wLayer[i]).toBe(wTilemap[i]);
    }
    // Sanity: translation column (m[12..14]) really carries the parent's pos.
    expect(wLayer[12]).toBeCloseTo(7, 5);
    expect(wLayer[13]).toBeCloseTo(-3, 5);
    expect(wLayer[14]).toBeCloseTo(11, 5);
  });

  it('stale ChildOf ref: Result.err(RhiError({ code: "hierarchy-broken" }))', () => {
    const world = new World();
    const ghost = world
      .spawn({
        component: Transform,
        data: identityTransformData(),
      })
      .unwrap();
    world.despawn(ghost).unwrap();
    const orphan = world
      .spawn(
        {
          component: Transform,
          data: identityTransformData(),
        },
        { component: ChildOf, data: { parent: ghost } },
      )
      .unwrap();
    void orphan;
    const r = propagateTransforms(world);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('hierarchy-broken');
    expect(r.error.hint.length).toBeGreaterThan(0);
    expect(r.error.expected.length).toBeGreaterThan(0);
  });
});
