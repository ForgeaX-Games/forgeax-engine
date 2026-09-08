// tilemap-validate.test - validateTilemapAtRegister + validateTileLayerAtRegister
// baseline fail-fast (feat-20260608 M0 baseline rebuild).
//
// validateTilemapAtRegister checks the Tilemap component invariants after
// spawn:
//   - cols / rows >= 1
//   - chunkSize >= 1
//   - tileset GUID is non-empty
//
// validateTileLayerAtRegister checks the TileLayer component invariants:
//   - tiles.length === parent.Tilemap.cols * rows (M0 second-stage
//     mutation-recheck — invariant must hold post-spawn).
//   - ChildOf parent must point at an entity carrying Tilemap.
//
// On invariant break the validator returns `Result.err(AssetError)` with
// `code === 'asset-invalid-value'` and `.detail.field` pointing at the
// offending invariant — consistent with the existing AssetRegistry
// validation shape (charter P4, fail-fast at register time).
//
// Anchors: plan-tasks m0-t5; plan-strategy §M0 (asset-registry validator
// baseline); charter P3.

import { World } from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { AssetError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { TileLayer, Tilemap } from '../../../render/src/components';
import {
  validateTileLayerAtRegister,
  validateTilemapAtRegister,
} from '../tilemap-register-validate';

function makeTilesetGuid(_world: World) {
  return 'test/tileset';
}

describe('validateTilemapAtRegister — M0 baseline invariants', () => {
  it('valid Tilemap returns Result.ok', () => {
    const world = new World();
    const tilesetGuid = makeTilesetGuid(world);
    const e = world
      .spawn({
        component: Tilemap,
        data: {
          cols: 2,
          rows: 2,
          tileSize: [16, 16],
          chunkSize: 8,
          tileset: tilesetGuid,
        },
      })
      .unwrap();
    const r = validateTilemapAtRegister(world, e);
    expect(r.ok).toBe(true);
  });

  it('cols === 0 fails', () => {
    const world = new World();
    const tilesetGuid = makeTilesetGuid(world);
    const e = world
      .spawn({
        component: Tilemap,
        data: {
          cols: 0,
          rows: 2,
          tileSize: [16, 16],
          chunkSize: 8,
          tileset: tilesetGuid,
        },
      })
      .unwrap();
    const r = validateTilemapAtRegister(world, e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(AssetError);
      expect(r.error.code).toBe('asset-invalid-value');
    }
  });

  it('rows === 0 fails', () => {
    const world = new World();
    const tilesetGuid = makeTilesetGuid(world);
    const e = world
      .spawn({
        component: Tilemap,
        data: {
          cols: 2,
          rows: 0,
          tileSize: [16, 16],
          chunkSize: 8,
          tileset: tilesetGuid,
        },
      })
      .unwrap();
    const r = validateTilemapAtRegister(world, e);
    expect(r.ok).toBe(false);
  });

  it('chunkSize === 0 fails', () => {
    const world = new World();
    const tilesetGuid = makeTilesetGuid(world);
    const e = world
      .spawn({
        component: Tilemap,
        data: {
          cols: 2,
          rows: 2,
          tileSize: [16, 16],
          chunkSize: 0,
          tileset: tilesetGuid,
        },
      })
      .unwrap();
    const r = validateTilemapAtRegister(world, e);
    expect(r.ok).toBe(false);
  });

  it('empty tileset GUID fails', () => {
    const world = new World();
    const e = world
      .spawn({
        component: Tilemap,
        data: {
          cols: 2,
          rows: 2,
          tileSize: [16, 16],
          chunkSize: 8,
          tileset: '',
        },
      })
      .unwrap();
    const r = validateTilemapAtRegister(world, e);
    expect(r.ok).toBe(false);
  });
});

describe('validateTileLayerAtRegister — M0 baseline invariants', () => {
  function spawnLayered(cols: number, rows: number, tileLen: number) {
    const world = new World();
    const tilesetGuid = makeTilesetGuid(world);
    const tilemap = world
      .spawn({
        component: Tilemap,
        data: { cols, rows, tileSize: [16, 16], chunkSize: 8, tileset: tilesetGuid },
      })
      .unwrap();
    const layer = world
      .spawn(
        { component: TileLayer, data: { tiles: new Uint32Array(tileLen), layerOrder: 0 } },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();
    return { world, tilemap, layer };
  }

  it('matching tiles.length passes', () => {
    const { world, layer } = spawnLayered(4, 3, 12);
    const r = validateTileLayerAtRegister(world, layer);
    expect(r.ok).toBe(true);
  });

  it('tiles.length too small fails', () => {
    const { world, layer } = spawnLayered(4, 3, 11);
    const r = validateTileLayerAtRegister(world, layer);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(AssetError);
      expect(r.error.code).toBe('asset-invalid-value');
    }
  });

  it('tiles.length too large fails', () => {
    const { world, layer } = spawnLayered(4, 3, 13);
    const r = validateTileLayerAtRegister(world, layer);
    expect(r.ok).toBe(false);
  });

  it('missing ChildOf fails', () => {
    const world = new World();
    const orphan = world
      .spawn({ component: TileLayer, data: { tiles: new Uint32Array(4) } })
      .unwrap();
    const r = validateTileLayerAtRegister(world, orphan);
    expect(r.ok).toBe(false);
  });

  it('ChildOf parent without Tilemap fails', () => {
    const world = new World();
    const nonTilemap = world
      .spawn({ component: TileLayer, data: { tiles: new Uint32Array(0) } })
      .unwrap();
    const layer = world
      .spawn(
        { component: TileLayer, data: { tiles: new Uint32Array(4) } },
        { component: ChildOf, data: { parent: nonTilemap } },
      )
      .unwrap();
    const r = validateTileLayerAtRegister(world, layer);
    expect(r.ok).toBe(false);
  });
});
