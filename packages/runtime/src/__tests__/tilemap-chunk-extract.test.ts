// tilemap-chunk-extract.test - per-cell entity TRS shape on dirty layers
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//  - One ECS entity is spawned per NON-ZERO cell (no Instances component).
//  - Each spawned entity carries Transform + MeshFilter (HANDLE_QUAD) +
//    MeshRenderer + Layer + ChildOf.
//  - Transform.posX = (cellX + 0.5) * tileSizeX (M0 1x1 unit-cell form).
//  - Transform.posY = (cellY + 0.5) * tileSizeY.
//  - scaleX sign encodes flipH, scaleY sign encodes flipV.
//  - quatZ / quatW encode D flip (90deg CW z-rotation).
//
// Anchors: plan-tasks m0-t9 / m0-t10; plan-strategy §D-1 per-cell entity TRS.

import { Entity, World } from '@forgeax/engine-ecs';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { HANDLE_QUAD } from '../asset-registry';
import { ChildOf, MeshFilter, TileLayer, Tilemap, Transform } from '../components';
import { encodeTileBits } from '../tile-bits';
import {
  resetTilemapChunkExtractCache,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

const SQRT1_2 = Math.SQRT1_2;

function makeSetup(opts: {
  cols: number;
  rows: number;
  tileSizeX?: number;
  tileSizeY?: number;
  chunkSize?: number;
  tiles: Uint32Array;
}) {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'test/tileset',
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
          tileSizeX: opts.tileSizeX ?? 1,
          tileSizeY: opts.tileSizeY ?? 1,
          chunkSize: opts.chunkSize ?? 16,
          tileset: tilesetHandle,
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  const layer = world
    .spawn(
      { component: TileLayer, data: { tiles: opts.tiles, layerOrder: 0, dirty: 1 } },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  return { world, tilemap, layer };
}

describe('tilemapChunkExtractSystem (M0 baseline)', () => {
  it('spawns one entity per non-zero cell (no Instances)', () => {
    const cols = 4;
    const rows = 4;
    const tiles = new Uint32Array(cols * rows);
    tiles[0] = 1;
    tiles[5] = 1;
    tiles[10] = 1;
    const { world } = makeSetup({ cols, rows, tiles });
    tilemapChunkExtractSystem(world);
    // 3 non-zero cells -> 3 derived entities.
    let derivedCount = 0;
    for (const arch of world.inspect().archetypes) {
      if (
        arch.componentNames.includes('MeshFilter') &&
        arch.componentNames.includes('MeshRenderer') &&
        arch.componentNames.includes('Layer') &&
        arch.componentNames.includes('ChildOf') &&
        !arch.componentNames.includes('Instances')
      ) {
        derivedCount += arch.entityCount;
      }
    }
    expect(derivedCount).toBe(3);
  });

  it('Transform.posX/posY land at cell center (M0 1x1 form)', () => {
    const cols = 2;
    const rows = 2;
    const tileSize = 16;
    const tiles = new Uint32Array(cols * rows);
    tiles[3] = 1; // cellX=1, cellY=1
    const { world } = makeSetup({
      cols,
      rows,
      tileSizeX: tileSize,
      tileSizeY: tileSize,
      tiles,
    });
    tilemapChunkExtractSystem(world);
    let posX = Number.NaN;
    let posY = Number.NaN;
    for (const arch of world.inspect().archetypes) {
      if (!arch.componentNames.includes('Transform')) continue;
      if (!arch.componentNames.includes('MeshFilter')) continue;
      if (!arch.componentNames.includes('Layer')) continue;
      // Found derived archetype; read first entity's Transform via inspect.
      // Use world.get on first entity in this archetype via the entity column.
      // (M0 baseline: there is exactly one derived entity here.)
      const derived = (
        world as unknown as {
          _getGraph(): {
            archetypes: Array<{
              key: string;
              columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
            }>;
          };
        }
      )
        ._getGraph()
        .archetypes.find((a) => a.key === arch.key);
      if (!derived) continue;
      const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as
        | Uint32Array
        | undefined;
      if (!entityCol) continue;
      const firstEntity = entityCol[0];
      if (firstEntity === undefined) continue;
      const t = world.get(firstEntity as never, Transform).unwrap();
      posX = t.posX;
      posY = t.posY;
    }
    expect(posX).toBeCloseTo((1 + 0.5) * tileSize, 5);
    expect(posY).toBeCloseTo((1 + 0.5) * tileSize, 5);
  });

  it('flipH negates scaleX; flipV negates scaleY; D sets quatZ=quatW=SQRT1_2', () => {
    const tileSize = 16;
    const tiles = new Uint32Array(1);
    tiles[0] = encodeTileBits(1, true, true, true, false);
    const { world } = makeSetup({
      cols: 1,
      rows: 1,
      tileSizeX: tileSize,
      tileSizeY: tileSize,
      tiles,
    });
    tilemapChunkExtractSystem(world);
    let scaleX = Number.NaN;
    let scaleY = Number.NaN;
    let quatZ = Number.NaN;
    let quatW = Number.NaN;
    for (const arch of world.inspect().archetypes) {
      if (!arch.componentNames.includes('Transform')) continue;
      if (!arch.componentNames.includes('MeshFilter')) continue;
      if (!arch.componentNames.includes('Layer')) continue;
      const derived = (
        world as unknown as {
          _getGraph(): {
            archetypes: Array<{
              key: string;
              columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
            }>;
          };
        }
      )
        ._getGraph()
        .archetypes.find((a) => a.key === arch.key);
      if (!derived) continue;
      const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as
        | Uint32Array
        | undefined;
      const firstEntity = entityCol?.[0];
      if (firstEntity === undefined) continue;
      const t = world.get(firstEntity as never, Transform).unwrap();
      scaleX = t.scaleX;
      scaleY = t.scaleY;
      quatZ = t.quatZ;
      quatW = t.quatW;
    }
    expect(scaleX).toBe(-tileSize);
    expect(scaleY).toBe(-tileSize);
    expect(quatZ).toBeCloseTo(SQRT1_2, 5);
    expect(quatW).toBeCloseTo(SQRT1_2, 5);
  });

  it('uses HANDLE_QUAD as the MeshFilter handle on derived entities', () => {
    const tiles = new Uint32Array(1);
    tiles[0] = 1;
    const { world } = makeSetup({ cols: 1, rows: 1, tiles });
    tilemapChunkExtractSystem(world);
    for (const arch of world.inspect().archetypes) {
      if (!arch.componentNames.includes('MeshFilter')) continue;
      if (!arch.componentNames.includes('ChildOf')) continue;
      const derived = (
        world as unknown as {
          _getGraph(): {
            archetypes: Array<{
              key: string;
              columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
            }>;
          };
        }
      )
        ._getGraph()
        .archetypes.find((a) => a.key === arch.key);
      if (!derived) continue;
      const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as
        | Uint32Array
        | undefined;
      const firstEntity = entityCol?.[0];
      if (firstEntity === undefined) continue;
      const mf = world.get(firstEntity as never, MeshFilter).unwrap();
      // Compare raw u32 (unwrap brand via numeric cast).
      expect(mf.assetHandle as unknown as number).toBe(HANDLE_QUAD as unknown as number);
    }
  });

  it('MeshRenderer is present on every derived entity', () => {
    const tiles = new Uint32Array(2);
    tiles[0] = 1;
    tiles[1] = 1;
    const { world } = makeSetup({ cols: 2, rows: 1, tiles });
    tilemapChunkExtractSystem(world);
    let count = 0;
    for (const arch of world.inspect().archetypes) {
      if (
        arch.componentNames.includes('MeshFilter') &&
        arch.componentNames.includes('MeshRenderer') &&
        arch.componentNames.includes('Layer') &&
        arch.componentNames.includes('ChildOf')
      ) {
        count += arch.entityCount;
      }
    }
    expect(count).toBe(2);
  });
});
