// pick-tile.test - pickTile cell-level query (worldX/Y -> tileId)
// (feat-20260608 M0 baseline rebuild).
//
// Anchors: plan-tasks m0-t7 / m0-t8; plan-strategy §D-5 / §M0 targetFiles
// (pickTile); feat-20260604 baseline; charter P3 explicit failure.

import { World } from '@forgeax/engine-ecs';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, TileLayer, Tilemap, Transform } from '../components';
import { pickTile } from '../pick-tile';

function makeFixture(opts: {
  cols: number;
  rows: number;
  layers: ReadonlyArray<{ layerOrder: number; tiles: readonly number[] }>;
}) {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'test/tileset',
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 1,
    tileHeight: 1,
    columns: opts.cols,
    rows: opts.rows,
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    tiles: [{ regionIndex: 0 }],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', tileset);
  const tilemap = world
    .spawn(
      { component: Tilemap, data: { cols: opts.cols, rows: opts.rows, tileset: tilesetHandle } },
      { component: Transform, data: {} },
    )
    .unwrap();
  const layerEntities = opts.layers.map((spec) => {
    const tilesArr = new Uint32Array(opts.cols * opts.rows);
    for (let i = 0; i < spec.tiles.length; i++) tilesArr[i] = spec.tiles[i] ?? 0;
    return world
      .spawn(
        { component: TileLayer, data: { tiles: tilesArr, layerOrder: spec.layerOrder } },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();
  });
  return { world, tilemap, layerEntities };
}

describe('pickTile (M0 baseline)', () => {
  it('hits the cell containing worldX/Y on a single-layer tilemap', () => {
    const { world, tilemap } = makeFixture({
      cols: 4,
      rows: 4,
      layers: [{ layerOrder: 0, tiles: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 1.5, 1.5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBeNull();
      if (r.value !== null) {
        expect(r.value.cellX).toBe(1);
        expect(r.value.cellY).toBe(1);
        expect(r.value.tileId).toBe(1);
      }
    }
  });

  it('returns Result.ok(null) when worldX/Y is out of bounds', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [{ layerOrder: 0, tiles: [1, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 100, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('returns Result.ok(null) when no non-zero tile occupies the cell', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [{ layerOrder: 0, tiles: [1, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 1.5, 1.5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('walks layers in layerOrder-descending order (high layer wins)', () => {
    // layer 0: cell (0,0) has tile 1
    // layer 5: cell (0,0) has tile 7
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [
        { layerOrder: 0, tiles: [1, 0, 0, 0] },
        { layerOrder: 5, tiles: [7, 0, 0, 0] },
      ],
    });
    const r = pickTile(world, tilemap, 0.5, 0.5);
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.tileId).toBe(7);
    } else {
      expect.fail('expected a hit');
    }
  });

  it('falls through to lower layer when higher layer has 0 at the cell', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [
        { layerOrder: 0, tiles: [3, 0, 0, 0] },
        { layerOrder: 5, tiles: [0, 0, 0, 0] },
      ],
    });
    const r = pickTile(world, tilemap, 0.5, 0.5);
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.tileId).toBe(3);
    } else {
      expect.fail('expected a hit');
    }
  });

  it('returns Result.err when the Tilemap entity does not exist', () => {
    const { world } = makeFixture({
      cols: 1,
      rows: 1,
      layers: [{ layerOrder: 0, tiles: [1] }],
    });
    const r = pickTile(world, 999 as number as never, 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.error.code === 'tilemap-not-found' || r.error.code === 'tilemap-component-missing',
      ).toBe(true);
    }
  });

  it('returns Result.err when the entity does not carry Tilemap', () => {
    const { world } = makeFixture({
      cols: 1,
      rows: 1,
      layers: [{ layerOrder: 0, tiles: [1] }],
    });
    const e = world.spawn({ component: Transform, data: {} }).unwrap();
    const r = pickTile(world, e, 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('tilemap-component-missing');
    }
  });
});
