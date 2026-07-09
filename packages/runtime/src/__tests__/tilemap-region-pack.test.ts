// tilemap-region-pack.test - per-cell entity Transform packing in cell units
// (feat-20260608 M0 baseline rebuild).
//
// Asserts the M0 1x1 unit-cell packing rules baked into
// `spawnDerivedRenderEntities`:
//
//   posX = (cellX + 0.5) * tileSizeX
//   posY = (cellY + 0.5) * tileSizeY
//   scaleX = +/- tileSizeX (sign encodes flipH)
//   scaleY = +/- tileSizeY (sign encodes flipV)
//   quatZ / quatW = D ? SQRT1_2 : 0 / D ? SQRT1_2 : 1
//
// M0 boundary: width/heightCells / pivotX/Y are NOT consumed yet (M2
// `feat-20260608` D-2 widens the form). 1x1 unit-cell only.
//
// Anchors: plan-tasks m0-t9; plan-strategy §D-1 per-cell entity TRS;
// plan-strategy §M0 (1x1 unit-cell baseline only).

import { Entity, World } from '@forgeax/engine-ecs';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, encodeSortScope, TileLayer, Tilemap, Transform } from '../components';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

function setup(opts: {
  cols: number;
  rows: number;
  tileSizeX: number;
  tileSizeY: number;
  tiles: Uint32Array;
}) {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'test/region-pack',
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 16,
    tileHeight: 16,
    columns: opts.cols,
    rows: opts.rows,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', tileset);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: {
          cols: opts.cols,
          rows: opts.rows,
          tileSizeX: opts.tileSizeX,
          tileSizeY: opts.tileSizeY,
          chunkSize: 4,
          tileset: tilesetHandle,
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world.spawn(
    {
      component: TileLayer,
      data: { tiles: opts.tiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('per-cell') },
    },
    { component: ChildOf, data: { parent: tilemap } },
  );
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world };
}

function readDerivedTransforms(world: World): Array<{
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
}> {
  type GraphArch = {
    key: string;
    columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
  };
  const graph = (world as unknown as { _getGraph(): { archetypes: GraphArch[] } })._getGraph();
  const out: Array<{
    posX: number;
    posY: number;
    scaleX: number;
    scaleY: number;
    quatZ: number;
    quatW: number;
  }> = [];
  for (const arch of world.inspect().archetypes) {
    if (!arch.componentNames.includes('Transform')) continue;
    if (!arch.componentNames.includes('MeshFilter')) continue;
    if (!arch.componentNames.includes('Layer')) continue;
    const derived = graph.archetypes.find((a) => a.key === arch.key);
    if (!derived) continue;
    const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as Uint32Array | undefined;
    if (!entityCol) continue;
    for (let i = 0; i < entityCol.length; i++) {
      const e = entityCol[i];
      if (e === undefined || e === 0) continue;
      const t = world.get(e as never, Transform).unwrap();
      out.push({
        posX: t.pos[0] ?? 0,
        posY: t.pos[1] ?? 0,
        scaleX: t.scale[0] ?? 1,
        scaleY: t.scale[1] ?? 1,
        quatZ: t.quat[2] ?? 0,
        quatW: t.quat[3] ?? 1,
      });
    }
  }
  return out;
}

describe('tilemap region pack — M0 1x1 unit-cell Transform field assertions', () => {
  it('non-unit tileSize: posX/posY follow (cellX + 0.5) * tileSize', () => {
    const tiles = new Uint32Array(2);
    tiles[0] = 1; // (0, 0)
    tiles[1] = 1; // (1, 0)
    const { world } = setup({ cols: 2, rows: 1, tileSizeX: 32, tileSizeY: 16, tiles });
    tilemapChunkExtractSystem(world, 0);
    const xs = readDerivedTransforms(world)
      .map((t) => t.posX)
      .sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.5 * 32, 5);
    expect(xs[1]).toBeCloseTo(1.5 * 32, 5);
  });

  it('default tileSize (1, 1) on a 1x1 cell anchored at (0, 0)', () => {
    const tiles = new Uint32Array([1]);
    const { world } = setup({ cols: 1, rows: 1, tileSizeX: 1, tileSizeY: 1, tiles });
    tilemapChunkExtractSystem(world, 0);
    const transforms = readDerivedTransforms(world);
    expect(transforms.length).toBe(1);
    const t = transforms[0];
    if (t === undefined) throw new Error('expected one derived Transform');
    expect(t.posX).toBeCloseTo(0.5, 5);
    expect(t.posY).toBeCloseTo(0.5, 5);
    expect(t.scaleX).toBe(1);
    expect(t.scaleY).toBe(1);
    expect(t.quatZ).toBe(0);
    expect(t.quatW).toBe(1);
  });

  it('flipH alone negates scaleX, flipV alone negates scaleY (per-cell sign)', () => {
    const tiles = new Uint32Array([encodeTileBits(1, true, false, false, false)]);
    const { world } = setup({ cols: 1, rows: 1, tileSizeX: 1, tileSizeY: 1, tiles });
    tilemapChunkExtractSystem(world, 0);
    const t = readDerivedTransforms(world)[0];
    if (t === undefined) throw new Error('expected one derived Transform');
    expect(t.scaleX).toBe(-1);
    expect(t.scaleY).toBe(1);
  });
});
