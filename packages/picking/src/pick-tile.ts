// pick-tile.ts - cell-level Tilemap query (feat-20260608 M0 baseline rebuild).
//
// `pickTile(world, tilemapEntity, worldX, worldY)` is a free function (not a
// method on `World` -- charter F1 single-import barrel from
// `@forgeax/engine-runtime`). It converts world-space coordinates into the
// Tilemap's local cell grid, walks every TileLayer that ChildOf-s the
// supplied tilemap, and returns the FIRST non-zero tile id seen when scanning
// layers in DESCENDING `layerOrder` (highest layer drawn on top wins).
//
// charter mapping:
//   - P3 explicit failure as value: out-of-bounds and "every layer empty"
//     resolve to `Result.ok(null)` -- never throws or fires onError. The
//     only `Result.err` path is a structural break (entity carries no
//     Tilemap component); the `PickTileError` union is closed to two
//     variants and stays a runtime-only type (not exported through
//     `@forgeax/engine-types`, since pickTile is a runtime-only system).
//   - P4 consistent abstraction: matches the `pick(world, ...)` raycast
//     surface in pick.ts -- free function, world+entity input, structured
//     error union, hit-or-null return.
//   - F1 single-import: exported from `@forgeax/engine-picking`'s barrel.
//
// Anchors: requirements §integration-points (engine-runtime pickTile);
// plan-tasks m0-t8; plan-strategy §D-5 file-by-file ECS API adaptation
// (createQueryState + queryRun pattern from render-system-extract.ts).

import {
  createQueryState,
  Entity,
  type EntityHandle,
  queryRun,
  type World,
} from '@forgeax/engine-ecs';
import { ChildOf, TileLayer, Tilemap, Transform } from '@forgeax/engine-runtime';
import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Closed error union for `pickTile` (charter P3 + P4). Two variants cover the
 * structural-break paths; "ray hit nothing" is a value (`Result.ok(null)`),
 * not an error.
 */
export type PickTileError =
  | { readonly code: 'tilemap-not-found'; readonly tilemapEntity: EntityHandle }
  | { readonly code: 'tilemap-component-missing'; readonly tilemapEntity: EntityHandle };

/**
 * Successful picking outcome. Returned through `Result.ok`; a `null` value
 * means the query landed in-bounds but every layer at that cell was empty
 * (or the point was outside the tilemap world bounds).
 */
export interface PickTileHit {
  readonly layerEntity: EntityHandle;
  readonly cellX: number;
  readonly cellY: number;
  readonly tileId: number;
}

/**
 * Find the topmost non-zero tile under `(worldX, worldY)` for a given
 * Tilemap entity, walking child TileLayer entities in DESCENDING
 * `layerOrder`.
 *
 * @returns
 *   - `Result.ok(PickTileHit)` for a non-zero cell on some layer.
 *   - `Result.ok(null)` for an empty cell or out-of-bounds query.
 *   - `Result.err(PickTileError)` when the supplied entity is not a Tilemap.
 */
export function pickTile(
  world: World,
  tilemapEntity: EntityHandle,
  worldX: number,
  worldY: number,
): Result<PickTileHit | null, PickTileError> {
  const tilemapResult = world.get(tilemapEntity, Tilemap);
  if (!tilemapResult.ok) {
    return err({ code: 'tilemap-component-missing', tilemapEntity });
  }
  const tilemap = tilemapResult.value;
  const cols = tilemap.cols;
  const rows = tilemap.rows;
  // feat-20260709 M3: tileSize is one inline array<f32,2> column; the
  // world.get read path materialises it as a Float32Array ([width, height]).
  const tileSizeX = tilemap.tileSize[0] ?? 1;
  const tileSizeY = tilemap.tileSize[1] ?? 1;

  // Tilemap origin in world space comes from its Transform.world translation
  // (column-major mat4 columns 12 / 13 carry world-X / world-Y). Tilemap
  // entities without a Transform default to origin (0, 0) -- the charter F1
  // "spawn(...) without Transform" path stays valid.
  let originX = 0;
  let originY = 0;
  const transformResult = world.get(tilemapEntity, Transform);
  if (transformResult.ok) {
    const w = transformResult.value.world;
    if (w !== undefined && w.length >= 14) {
      originX = w[12] ?? 0;
      originY = w[13] ?? 0;
    }
  }

  const localX = worldX - originX;
  const localY = worldY - originY;
  if (tileSizeX <= 0 || tileSizeY <= 0) return ok(null);
  if (localX < 0 || localY < 0) return ok(null);

  const cellX = Math.floor(localX / tileSizeX);
  const cellY = Math.floor(localY / tileSizeY);
  if (cellX < 0 || cellY < 0 || cellX >= cols || cellY >= rows) return ok(null);

  // Collect every TileLayer ChildOf-ing the supplied Tilemap entity, with
  // its layerOrder + tile array snapshot. The createQueryState + queryRun
  // walk follows main's M1 ECS API (tweak-20260611 + tweak-20260612).
  type LayerInfo = {
    readonly entity: EntityHandle;
    readonly tiles: ArrayLike<number>;
    readonly layerOrder: number;
  };
  const layers: LayerInfo[] = [];
  const layerQuery = createQueryState({ with: [TileLayer, ChildOf, Entity] });
  queryRun(layerQuery, world, (bundle) => {
    const childOfBundle = bundle.ChildOf;
    const layerBundle = bundle.TileLayer;
    const entitySelf = bundle.Entity.self as unknown as Uint32Array;
    for (let i = 0; i < entitySelf.length; i++) {
      const layerEntity = (entitySelf[i] ?? 0) as EntityHandle;
      const parent = (childOfBundle.parent[i] ?? 0) as EntityHandle;
      if ((parent as unknown as number) !== (tilemapEntity as unknown as number)) continue;
      const layerData = world.get(layerEntity, TileLayer);
      if (!layerData.ok) continue;
      layers.push({
        entity: layerEntity,
        tiles: layerData.value.tiles as ArrayLike<number>,
        layerOrder: layerBundle.layerOrder[i] ?? 0,
      });
    }
  });

  layers.sort((a, b) => b.layerOrder - a.layerOrder);

  const cellIndex = cellY * cols + cellX;
  for (const layer of layers) {
    if (cellIndex >= layer.tiles.length) continue;
    const tileId = layer.tiles[cellIndex] ?? 0;
    if (tileId !== 0) {
      return ok({
        layerEntity: layer.entity,
        cellX,
        cellY,
        tileId,
      });
    }
  }
  return ok(null);
}
