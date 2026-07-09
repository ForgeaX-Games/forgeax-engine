// @forgeax/engine-runtime — Tilemap / TileLayer register-time component
// validators (feat-20260705-runtime-tier2-decomposition M1 / w3, D-4 F1 block).
//
// These two validators are the ONLY code in the former asset-registry.ts that
// imports runtime ECS components (ChildOf / TileLayer / Tilemap — research F8).
// They have zero production callers inside AssetRegistry (only the
// tilemap-validate.test.ts unit test consumes them), so externalizing them into
// their own runtime-owned file severs the asset cluster -> components reverse
// edge (research F7 reverse edge #1) while keeping the validators on the runtime
// side of the M1 package split (requirements OOS-5: this file is the final
// state, no further migration to a tilemap feature package).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import { ASSET_ERROR_HINTS, AssetError, handleSlot } from '@forgeax/engine-types';
import {
  ChildOf as runtimeChildOf,
  TileLayer as runtimeTileLayer,
  Tilemap as runtimeTilemap,
} from './components';

function invalidValue(field: string, value: unknown, reason: string): AssetError {
  return new AssetError({
    code: 'asset-invalid-value',
    expected: `register-time invariant for ${field}`,
    hint: `${ASSET_ERROR_HINTS['asset-invalid-value']} (${reason})`,
    detail: { field, value, reason },
  });
}

/**
 * Validate Tilemap component invariants on the spawned entity (M0 baseline).
 *
 * Checks: `cols / rows >= 1`, `chunkSize >= 1`, `tileset` handle != 0.
 * Returns `Result.ok(undefined)` when every invariant holds, otherwise
 * `Result.err(AssetError 'asset-invalid-value')` with field-specific
 * detail (charter P3 fail-fast + P4 consistent with `validateMeshPayload`).
 */
export function validateTilemapAtRegister(
  world: World,
  tilemapEntity: EntityHandle,
): Result<void, AssetError> {
  const r = world.get(tilemapEntity, runtimeTilemap);
  if (!r.ok) {
    return err(invalidValue('Tilemap', tilemapEntity, 'tilemap-entity-missing-component'));
  }
  const cols = r.value.cols;
  const rows = r.value.rows;
  const chunkSize = r.value.chunkSize;
  const tileset = r.value.tileset;
  if (!(cols >= 1)) return err(invalidValue('Tilemap.cols', cols, 'cols-below-one'));
  if (!(rows >= 1)) return err(invalidValue('Tilemap.rows', rows, 'rows-below-one'));
  if (!(chunkSize >= 1)) {
    return err(invalidValue('Tilemap.chunkSize', chunkSize, 'chunkSize-below-one'));
  }
  if (handleSlot(tileset) === 0) {
    return err(invalidValue('Tilemap.tileset', tileset, 'tileset-handle-zero'));
  }
  return ok(undefined);
}

/**
 * Validate TileLayer component invariants on the spawned entity (M0 baseline).
 *
 * Checks: parent `ChildOf` points at a Tilemap-carrying entity AND
 * `tiles.length === parent.cols * parent.rows` (M0 second-stage mutation
 * recheck; the invariant must hold after every spawn-time mutation).
 */
export function validateTileLayerAtRegister(
  world: World,
  layerEntity: EntityHandle,
): Result<void, AssetError> {
  const layer = world.get(layerEntity, runtimeTileLayer);
  if (!layer.ok) {
    return err(invalidValue('TileLayer', layerEntity, 'tilelayer-entity-missing-component'));
  }
  const child = world.get(layerEntity, runtimeChildOf);
  if (!child.ok) {
    return err(invalidValue('TileLayer.ChildOf', layerEntity, 'tilelayer-missing-childof'));
  }
  const parentEntity = child.value.parent as EntityHandle;
  const parentTilemap = world.get(parentEntity, runtimeTilemap);
  if (!parentTilemap.ok) {
    return err(
      invalidValue('TileLayer.ChildOf.parent', parentEntity, 'tilelayer-parent-not-tilemap'),
    );
  }
  const expectedLen = parentTilemap.value.cols * parentTilemap.value.rows;
  const actualLen = layer.value.tiles.length;
  if (actualLen !== expectedLen) {
    return err(
      invalidValue(
        'TileLayer.tiles.length',
        actualLen,
        `tilelayer-tiles-length-mismatch (expected ${expectedLen}, got ${actualLen})`,
      ),
    );
  }
  return ok(undefined);
}
