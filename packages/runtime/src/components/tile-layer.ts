// @forgeax/engine-runtime - TileLayer (one render layer of a Tilemap).
//
// Schema (4 fields):
//   tiles       array<u32>  per-cell tile id (packed Tiled .tmj wire form);
//                           length == parent.Tilemap.cols * rows.
//   layerOrder  i32         render-order key (higher = drawn on top).
//   dirty       u8          0 means clean, non-zero means dirty - the next
//                           tilemap-chunk-extract-system pass rebuilds derived
//                           per-cell entities for this layer.
//   ySort       u8          0 (default) = standard chunk-indexed Layer.value
//                           encoding: (layerOrder<<20)|chunkIndex.
//                           1 = Y-sort mode: all derived entities in this
//                           layer share Layer.value = (layerOrder<<20), so
//                           they Y-sort together with sprite entities that
//                           carry the same Layer.value (e.g. a player sprite
//                           with SPRITE_LAYER_VALUE = layerOrder<<20).
//
// Each TileLayer entity attaches to a Tilemap entity via ChildOf (the parent
// field carries the Tilemap entity). M0 supports multiple TileLayer entities
// per Tilemap (each rendered as an independent z-ordered layer).
//
// charter mapping: F1 (single-import barrel), P3 (dirty flag is explicit -
// silent re-extraction is forbidden), P4 (handle-free row schema mirrors
// MeshFilter / MeshRenderer conventions).

import { defineComponent, type EcsError, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Result } from '@forgeax/engine-types';

/**
 * TileLayer component (M0 baseline rebuild).
 *
 * AI users typically spawn a TileLayer + ChildOf pair pointing at an
 * existing Tilemap entity:
 *
 * @example
 *   const tilesArray = new Uint32Array(cols * rows);
 *   tilesArray[5 * cols + 7] = 1; // tile id 1 at cell (7, 5)
 *   world.spawn(
 *     { component: TileLayer, data: { tiles: tilesArray, layerOrder: 0 } },
 *     { component: ChildOf,  data: { parent: tilemapEntity } },
 *   );
 *
 * Defaults: `layerOrder = 0`, `dirty = 0`. `tiles` has no default - AI
 * users supply the per-cell array at spawn time. To trigger a re-build
 * after mutating tiles in place, call `markTileLayerDirty(world, layer)`.
 */
export const TileLayer = defineComponent('TileLayer', {
  tiles: { type: 'array<u32>' },
  layerOrder: { type: 'i32', default: 0 },
  dirty: { type: 'u8', default: 0 },
  ySort: { type: 'u8', default: 0 },
});

/**
 * Mark a TileLayer entity dirty so the next `tilemapChunkExtractSystem`
 * pass purges and re-spawns its derived per-cell entities. Use this after
 * mutating `TileLayer.tiles` (e.g. an in-place patch via a column view).
 *
 * Returns the underlying ECS write result - on `err` branch the caller
 * can read `.code` to recover (`'stale-entity'` if the layer was
 * despawned, `'component-not-present'` if the entity is missing the
 * TileLayer column; both kebab-case literals are members of the closed
 * `EcsErrorCode` union).
 */
export function markTileLayerDirty(
  world: World,
  layerEntity: EntityHandle,
): Result<void, EcsError> {
  return world.set(layerEntity, TileLayer, { dirty: 1 });
}
