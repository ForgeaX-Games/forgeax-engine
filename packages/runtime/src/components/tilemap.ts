// @forgeax/engine-runtime - Tilemap (grid + tileset reference).
//
// Schema (6 fields):
//   cols       u32         total grid columns
//   rows       u32         total grid rows
//   tileSizeX  f32         per-cell world width  (default 1.0)
//   tileSizeY  f32         per-cell world height (default 1.0)
//   chunkSize  u32         per-chunk axis-length in cells (default 16)
//   tileset    shared<TilesetAsset>  reference into AssetRegistry
//
// Naming: single-semantic Tilemap (AGENTS.md §Component naming drops
// `Component` suffix). One Tilemap entity per grid; TileLayer entities
// attach via ChildOf relationship and supply the per-cell tile id array
// for a single render-layer.
//
// charter mapping: F1 (single-import barrel from `@forgeax/engine-runtime`),
// P1 (progressive disclosure - defaults cover the common case), P4 (handle
// schema-vocab consistent with other engine handle columns).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Tilemap component (M0 baseline rebuild).
 *
 * A Tilemap entity carries grid metadata + a single `tileset` handle. The
 * actual per-cell tile id array lives on attached `TileLayer` entities
 * (one per render layer; ChildOf points back to the Tilemap entity).
 *
 * Defaults:
 *   - `tileSizeX = tileSizeY = 1.0` (unit-cell world coordinates).
 *   - `chunkSize = 16` (tilemap-chunk-extract-system chunks 16x16 cells).
 *
 * @example Spawn a 32x32 unit-cell Tilemap referencing a TilesetAsset:
 *   const tilemap = world.spawn(
 *     { component: Tilemap, data: { cols: 32, rows: 32, tileset } },
 *     { component: Transform, data: {} },
 *   ).unwrap();
 */
export const Tilemap = defineComponent('Tilemap', {
  cols: { type: 'u32', default: 0 },
  rows: { type: 'u32', default: 0 },
  tileSizeX: { type: 'f32', default: 1 },
  tileSizeY: { type: 'f32', default: 1 },
  chunkSize: { type: 'u32', default: 16 },
  tileset: { type: 'shared<TilesetAsset>' },
});
