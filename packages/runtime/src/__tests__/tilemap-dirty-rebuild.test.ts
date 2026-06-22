// tilemap-dirty-rebuild.test - dirty flag rebuild + first-frame heuristic
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//   - First frame (dirty=0 but layer never extracted) still spawns derived
//     entities (charter F1 progressive disclosure -- AI users do not need
//     to manually call markTileLayerDirty on freshly-spawned layers).
//   - markTileLayerDirty(world, layer) triggers a full purge + rebuild on
//     the next tilemapChunkExtractSystem pass.
//   - Idempotent: calling the system twice without mutating tiles does not
//     produce duplicate derived entities.
//
// Anchors: plan-tasks m0-t9; charter F1.

import { World } from '@forgeax/engine-ecs';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, markTileLayerDirty, TileLayer, Tilemap, Transform } from '../components';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

function setup() {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'test/tileset',
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', tileset);
  const tilemap = world
    .spawn(
      { component: Tilemap, data: { cols: 2, rows: 2, tileset: tilesetHandle } },
      { component: Transform, data: {} },
    )
    .unwrap();
  const tiles = new Uint32Array([1, 0, 0, 1]);
  const layer = world
    .spawn(
      { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 0 } },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, tilemap, layer };
}

function countDerived(world: World): number {
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
  return count;
}

describe('tilemap dirty rebuild (M0 baseline)', () => {
  it('first frame: dirty=0 + never-built layer still spawns derived entities', () => {
    const { world } = setup();
    expect(countDerived(world)).toBe(0);
    tilemapChunkExtractSystem(world);
    expect(countDerived(world)).toBe(2);
  });

  it('idempotent: second pass without dirty flag does not duplicate entities', () => {
    const { world } = setup();
    tilemapChunkExtractSystem(world);
    const after1 = countDerived(world);
    tilemapChunkExtractSystem(world);
    const after2 = countDerived(world);
    expect(after2).toBe(after1);
  });

  it('markTileLayerDirty triggers a full rebuild on the next pass', () => {
    const { world, layer } = setup();
    tilemapChunkExtractSystem(world);
    expect(countDerived(world)).toBe(2);
    // Mutate the tiles array in place + mark dirty.
    const tiles = world.get(layer, TileLayer).unwrap().tiles as Uint32Array;
    tiles[1] = 1; // adds a non-zero cell
    markTileLayerDirty(world, layer).unwrap();
    tilemapChunkExtractSystem(world);
    expect(countDerived(world)).toBe(3);
  });
});
