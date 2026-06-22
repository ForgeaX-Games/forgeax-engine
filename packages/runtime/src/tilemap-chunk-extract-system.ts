// @forgeax/engine-runtime - tilemap-chunk-extract-system.
//
// Walks every TileLayer attached to a Tilemap via ChildOf; when a layer is
// dirty (or has never been extracted), purges its previously-spawned derived
// per-cell entities and re-spawns one ECS entity per non-zero cell. Each
// derived entity carries Transform + MeshFilter (HANDLE_QUAD) + MeshRenderer
// + Layer + ChildOf (back to the parent layer entity).
//
// M0 baseline: unit-cell 1x1 form, single-atlas, no UV inset.
// M2 extension (plan-strategy §D-2 + §D-7 step 3):
// M3 extension (plan-strategy §D-7 step 2 + §D-12):
//   - resolveTilesetMaterial walks the 3-hop chain
//     `tile.regionIndex -> regions[i].atlasIndex ?? 0 -> atlases[idx]`
//     so multi-atlas tilesets route each region to the correct GPU
//     texture handle (requirements AC-04 / AC-11). Cache key stays
//     binary `(atlasHandle, regionIndex)` -- atlasHandle already
//     encodes the atlas pick.
//   - spawnDerivedRenderEntities scales the quad by widthCells x
//     heightCells (defaults 1 x 1) and offsets the centre so the pivot
//     lands at the (pivotX, pivotY) location inside the anchor cell.
//   - basePivotForX = D ? pivotY : pivotX (and dually for Y), so the
//     90deg CW z-rotation correctly swaps which atlas-axis pivot maps
//     to which world axis.
//   - effectivePivotX = H ? (1 - basePivotForX) : basePivotForX (and
//     dually for Y). The anchor pivot under H flip lands at the
//     mirrored cell position (charter P4 - same semantics as Tiled's
//     "pivot stays in atlas-local coords, flips with the texel grid").
//   - posX = (cellX + effectivePivotX + (0.5 - effectivePivotX) * widthCells)
//            * tileSizeX
//     posY analogous with effectivePivotY + heightCells.
//   - scaleX/scaleY: signed by H/V flip; magnitude is widthCells *
//     tileSizeX / heightCells * tileSizeY (multi-cell scale).
//   - resolveTilesetMaterial inset-shrinks the region UV rectangle by
//     half a texel on every edge so GPU bilinear filtering at the
//     atlas-tile boundary never bleeds into the adjacent tile
//     (charter P3 - default behaviour avoids visual defects).
//
// M3 boundary: per-entity sort key with effectivePivotY is wired in
// render-system-extract (m3-t5), not here.
//
// Cache key for resolveTilesetMaterial is BINARY: (atlasHandle, regionIndex).
// AI users widthCells / pivot variations share the same material handle
// (charter P4 consistent abstraction; plan-strategy §D-9 / §D-12).
//
// Anchors: plan-tasks m0-t10 / m2-t2 / m2-t4; plan-strategy §D-1 +
// §D-2 (multi-cell + flip x pivot) + §D-5 (M0 baseline file-by-file
// ECS API adaptation) + §D-7 step 3 (half-texel UV inset).

import {
  createQueryState,
  Entity,
  type EntityHandle,
  queryRun,
  type World,
} from '@forgeax/engine-ecs';
import {
  type Handle,
  type MaterialAsset,
  type TilesetAsset,
  unwrapHandle,
} from '@forgeax/engine-types';
import { HANDLE_QUAD } from './asset-registry';
import {
  ChildOf,
  Layer,
  MeshFilter,
  MeshRenderer,
  TileLayer,
  Tilemap,
  Transform,
} from './components';
import { resolveAssetHandle } from './resolve-asset-handle';
import { decodeTileBits } from './tile-bits';

// Module-scoped caches (charter P5 — engine-side memoisation; AI users
// never reach in). Test harness can flush them via the reset helpers.
const atlasMaterialCache = new Map<string, number>();
const layerDerivedEntities = new Map<number, number[]>();
const layerEverBuilt = new Set<number>();

/**
 * Flush the (atlasHandle, regionIndex) material cache. Useful in test
 * harnesses + after a TilesetAsset reload.
 */
export function resetTilemapChunkExtractCache(): void {
  atlasMaterialCache.clear();
}

/**
 * Flush the per-layer derived-entity tracker + the first-frame heuristic
 * set. Useful in test harnesses + when the World is re-created.
 */
export function resetTilemapDerivedEntityTracker(): void {
  layerDerivedEntities.clear();
  layerEverBuilt.clear();
}

/**
 * Compute the per-layer / per-chunk packed value carried in `Layer.value`
 * on derived entities. `(layerOrder << 20) | (chunkIndex & 0xFFFFF)` —
 * layerOrder dominates the sort, chunkIndex tiebreaks within a layer.
 */
export function encodeTilemapLayerValue(layerOrder: number, chunkIndex: number): number {
  return (layerOrder << 20) | (chunkIndex & 0xfffff) | 0;
}

/**
 * Resolve (regionIndex) into a per-tile sprite material handle by walking
 * the 3-hop chain:
 *
 *   tile.regionIndex -> regions[regionIndex] -> region.atlasIndex ?? 0
 *                    -> atlases[atlasIndex]
 *
 * (plan-strategy §D-7 step 2 + requirements §AC-04 / §AC-11). Caches the
 * resulting MaterialAsset handle so repeated lookups hit a single
 * registered material per atlas-region pair; the cache key stays the
 * binary tuple `(atlasHandle, regionIndex)` -- atlasHandle already
 * encodes the atlasIndex pick so widening to a 3-tuple key would only
 * inflate the SSOT without adding signal (charter P4 + plan-strategy
 * §D-12). atlasIndex out-of-range is caught at register time by
 * `validateTilesetPayload` (m1-t6); the runtime resolver falls through
 * to handle 0 when an atlas slot is unexpectedly empty so the renderer
 * skips the draw rather than silently sampling the wrong texture
 * (charter P3 fail-safe).
 *
 * The shader is `forgeax::sprite`; paramValues are filled with the atlas
 * texture handle + a UV region rectangle covering the supplied
 * TilesetRegion (half-texel inset added in m2-t4).
 */
function resolveTilesetMaterial(world: World, tileset: TilesetAsset, regionIndex: number): number {
  const region = tileset.regions[regionIndex];
  if (region === undefined) return 0;
  // 3-hop walk: regions[i].atlasIndex (default 0) -> atlases[atlasIndex].
  // atlasIndex out-of-range is register-time fail-fast via
  // `validateTilesetPayload` (m1-t6); the runtime resolver still bails
  // when the slot is unexpectedly empty (charter P3 fail-safe).
  const atlasIndex = region.atlasIndex ?? 0;
  const atlasHandle = tileset.atlases[atlasIndex];
  if (atlasHandle === undefined) return 0;
  const atlasId = unwrapHandle(atlasHandle as unknown as Handle<'TextureAsset', 'shared'>);
  const cacheKey = `${atlasId}|${regionIndex}`;
  const cached = atlasMaterialCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Atlas-space rectangle -> normalised UV. M2 adds a half-texel inset
  // on every edge (plan-strategy §D-7 step 3) so GPU bilinear filtering
  // at the region boundary never samples the adjacent atlas tile. Atlas
  // pixel extent is inferred from the tileset grid metadata so the math
  // stays self-contained.
  const atlasWidth = Math.max(1, tileset.columns * tileset.tileWidth);
  const atlasHeight = Math.max(1, tileset.rows * tileset.tileHeight);
  const halfTexelU = 0.5 / atlasWidth;
  const halfTexelV = 0.5 / atlasHeight;
  const u = region.x / atlasWidth + halfTexelU;
  const v = region.y / atlasHeight + halfTexelV;
  const w = region.width / atlasWidth - 2 * halfTexelU;
  const h = region.height / atlasHeight - 2 * halfTexelV;

  const matPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'sprite',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      texture: atlasId,
      region: [u, v, w, h],
      pivot: [0.5, 0.5],
      flipX: 0.0,
      flipY: 0.0,
      slices: [0.0, 0.0, 0.0, 0.0],
      sliceMode: 0.0,
    },
  };
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    matPayload,
  );
  const id = unwrapHandle(matHandle);
  atlasMaterialCache.set(cacheKey, id);
  return id;
}

interface DerivedSpawnSpec {
  readonly cellX: number;
  readonly cellY: number;
  readonly tileId: number;
  readonly packedTile: number;
  readonly materialHandle: number;
  readonly chunkIndex: number;
  // M2: multi-cell footprint + custom pivot land per-tile via TilesetTileEntry.
  readonly widthCells: number;
  readonly heightCells: number;
  readonly pivotX: number;
  readonly pivotY: number;
}

const SQRT1_2 = Math.SQRT1_2;

/**
 * Compute the post-flip "effective pivot Y" for a tilemap tile entry.
 *
 * Mirrors the D-2 first-line composition used by `spawnDerivedRenderEntities`:
 *
 *   basePivotForY = flipDiagonal ? pivotX : pivotY
 *   effectivePivotY = flipV ? (1 - basePivotForY) : basePivotForY
 *
 * Exported so the render-system-extract sprite-bucket sort key path can
 * reproduce the *same* per-entity pivot value that landed on
 * `Transform.posY` -- otherwise the foot-Y formula
 * `posY - effectivePivotY * |scaleY|` would drift on flipped tiles
 * (charter P4 single-source pivot SSOT; plan-strategy §D-1 + §D-2 +
 * requirements §AC-12 / §AC-13).
 */
export function effectivePivotYForTilemapFlip(
  pivotY: number,
  pivotX: number,
  flipV: boolean,
  flipDiagonal: boolean,
): number {
  const base = flipDiagonal ? pivotX : pivotY;
  return flipV ? 1 - base : base;
}

/**
 * Compute the per-cell derived spawn spec for one non-zero cell. Carries
 * widthCells / heightCells / pivotX / pivotY from the TilesetTileEntry so
 * `spawnDerivedRenderEntities` can apply the D-2 geometric correction
 * without re-reading the asset registry.
 */
function specFor(
  layerCols: number,
  chunkSize: number,
  cellIndex: number,
  packedTile: number,
  materialHandle: number,
  entry: {
    widthCells?: number;
    heightCells?: number;
    pivotX?: number;
    pivotY?: number;
  },
): DerivedSpawnSpec {
  const cellX = cellIndex % layerCols;
  const cellY = Math.floor(cellIndex / layerCols);
  const chunkX = Math.floor(cellX / chunkSize);
  const chunkY = Math.floor(cellY / chunkSize);
  const chunksPerRow = Math.max(1, Math.ceil(layerCols / chunkSize));
  const chunkIndex = chunkY * chunksPerRow + chunkX;
  const { tileId } = decodeTileBits(packedTile);
  return {
    cellX,
    cellY,
    tileId,
    packedTile,
    materialHandle,
    chunkIndex,
    widthCells: entry.widthCells ?? 1,
    heightCells: entry.heightCells ?? 1,
    pivotX: entry.pivotX ?? 0.5,
    pivotY: entry.pivotY ?? 0.5,
  };
}

/**
 * Spawn a single derived per-cell render entity. Applies the plan-strategy
 * §D-2 multi-cell + flip x pivot composite formula (first-line form):
 *
 *   basePivotForX = D ? pivotY : pivotX
 *   basePivotForY = D ? pivotX : pivotY
 *   effectivePivotX = H ? (1 - basePivotForX) : basePivotForX
 *   effectivePivotY = V ? (1 - basePivotForY) : basePivotForY
 *   posX = (cellX + effectivePivotX + (0.5 - effectivePivotX) * widthCells)
 *          * tileSizeX
 *   posY = (cellY + effectivePivotY + (0.5 - effectivePivotY) * heightCells)
 *          * tileSizeY
 *   scaleX = (H ? -1 : 1) * widthCells  * tileSizeX
 *   scaleY = (V ? -1 : 1) * heightCells * tileSizeY
 *   quatZ  = D ? Math.SQRT1_2 : 0
 *   quatW  = D ? Math.SQRT1_2 : 1
 *
 * The first-line `posX = pivot_world_X + (0.5 - pivotX) * widthCells *
 * tileSizeX` is preserved through the algebraic expansion so the 32-case
 * matrix in tilemap-spawn-flip-pivot.test.ts catches any regression.
 */
function spawnDerivedRenderEntities(
  world: World,
  layerEntity: EntityHandle,
  tilemap: { tileSizeX: number; tileSizeY: number },
  layerOrder: number,
  spec: DerivedSpawnSpec,
  packedTile: number,
): EntityHandle {
  const { flipH, flipV, flipDiagonal } = decodeTileBits(packedTile);
  // D-2 first-line: D swaps the X/Y pivot pair so the 90deg rotation
  // moves the anchor to the correct atlas axis; H/V then mirror within
  // their respective slot. The Y branch is also exported as
  // `effectivePivotYForTilemapFlip` so the render-system-extract sort
  // key path (m3-t5) sees the same value (charter P4 single SSOT).
  const basePivotForX = flipDiagonal ? spec.pivotY : spec.pivotX;
  const effectivePivotX = flipH ? 1 - basePivotForX : basePivotForX;
  const effectivePivotY = effectivePivotYForTilemapFlip(
    spec.pivotY,
    spec.pivotX,
    flipV,
    flipDiagonal,
  );
  const posX =
    (spec.cellX + effectivePivotX + (0.5 - effectivePivotX) * spec.widthCells) * tilemap.tileSizeX;
  const posY =
    (spec.cellY + effectivePivotY + (0.5 - effectivePivotY) * spec.heightCells) * tilemap.tileSizeY;
  const scaleX = (flipH ? -1 : 1) * spec.widthCells * tilemap.tileSizeX;
  const scaleY = (flipV ? -1 : 1) * spec.heightCells * tilemap.tileSizeY;
  const quatZ = flipDiagonal ? SQRT1_2 : 0;
  const quatW = flipDiagonal ? SQRT1_2 : 1;
  const layerValue = encodeTilemapLayerValue(layerOrder, spec.chunkIndex);
  return world
    .spawn(
      {
        component: Transform,
        data: {
          posX,
          posY,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ,
          quatW,
          scaleX,
          scaleY,
          scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      {
        component: MeshRenderer,
        data: {
          materials: [spec.materialHandle as unknown as Handle<'MaterialAsset', 'shared'>],
        },
      },
      { component: Layer, data: { value: layerValue } },
      { component: ChildOf, data: { parent: layerEntity } },
    )
    .unwrap();
}

/**
 * Bucket a single layer's tiles into per-non-zero-cell spawn specs.
 * Returns the parent Tilemap metadata + the resolved spawn specs.
 */
function bucketTileLayer(
  world: World,
  layerEntity: EntityHandle,
  parentEntity: EntityHandle,
):
  | {
      readonly tilemap: {
        cols: number;
        rows: number;
        tileSizeX: number;
        tileSizeY: number;
        chunkSize: number;
      };
      readonly layerOrder: number;
      readonly specs: readonly DerivedSpawnSpec[];
    }
  | undefined {
  const tilemapRes = world.get(parentEntity, Tilemap);
  if (!tilemapRes.ok) return undefined;
  const tilemap = tilemapRes.value;
  const tilesetRes = resolveAssetHandle<TilesetAsset>(
    world,
    tilemap.tileset as unknown as Handle<string, 'shared'>,
  );
  if (!tilesetRes.ok) return undefined;
  const tileset = tilesetRes.value;

  const layerRes = world.get(layerEntity, TileLayer);
  if (!layerRes.ok) return undefined;
  const layer = layerRes.value;
  const tiles = layer.tiles as Uint32Array;

  const specs: DerivedSpawnSpec[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const packed = tiles[i] ?? 0;
    if (packed === 0) continue;
    const { tileId } = decodeTileBits(packed);
    if (tileId === 0) continue;
    const entry = tileset.tiles[tileId - 1];
    if (entry === undefined) continue;
    const materialHandle = resolveTilesetMaterial(world, tileset, entry.regionIndex);
    const spec = specFor(tilemap.cols, tilemap.chunkSize, i, packed, materialHandle, entry);
    specs.push(spec);
  }
  return {
    tilemap,
    layerOrder: layer.layerOrder,
    specs,
  };
}

function purgeDerivedEntities(world: World, layerEntity: EntityHandle): void {
  const layerKey = unwrapHandle(layerEntity as unknown as Handle<string, 'shared'>);
  const tracked = layerDerivedEntities.get(layerKey);
  if (tracked === undefined) return;
  for (const e of tracked) {
    world.despawn(e as EntityHandle);
  }
  layerDerivedEntities.delete(layerKey);
}

/**
 * Walk every TileLayer ChildOf-ing a Tilemap, extract its non-zero cells
 * into derived per-cell render entities, and store the spawn list so the
 * next dirty pass can purge cleanly. Called per-frame from
 * `createRenderer.draw` before the render system reads the world.
 */
export function tilemapChunkExtractSystem(world: World): void {
  type LayerWork = {
    readonly layerEntity: EntityHandle;
    readonly parentEntity: EntityHandle;
    readonly dirty: number;
  };
  const work: LayerWork[] = [];
  const tileLayerQuery = createQueryState({ with: [TileLayer, ChildOf, Entity] });
  queryRun(tileLayerQuery, world, (bundle) => {
    const childOfBundle = bundle.ChildOf;
    const layerBundle = bundle.TileLayer;
    const entitySelf = bundle.Entity.self as unknown as Uint32Array;
    for (let i = 0; i < entitySelf.length; i++) {
      const e = (entitySelf[i] ?? 0) as EntityHandle;
      const parent = (childOfBundle.parent[i] ?? 0) as EntityHandle;
      work.push({
        layerEntity: e,
        parentEntity: parent,
        dirty: layerBundle.dirty[i] ?? 0,
      });
    }
  });

  for (const w of work) {
    const layerKey = unwrapHandle(w.layerEntity as unknown as Handle<string, 'shared'>);
    const everBuilt = layerEverBuilt.has(layerKey);
    if (everBuilt && w.dirty === 0) continue;

    // Re-build: purge old then spawn new.
    purgeDerivedEntities(world, w.layerEntity);

    const bucket = bucketTileLayer(world, w.layerEntity, w.parentEntity);
    if (bucket === undefined) {
      layerEverBuilt.add(layerKey);
      continue;
    }

    const spawned: number[] = [];
    for (const spec of bucket.specs) {
      const e = spawnDerivedRenderEntities(
        world,
        w.layerEntity,
        bucket.tilemap,
        bucket.layerOrder,
        spec,
        spec.packedTile,
      );
      spawned.push(unwrapHandle(e as unknown as Handle<string, 'shared'>));
    }
    layerDerivedEntities.set(layerKey, spawned);
    layerEverBuilt.add(layerKey);

    // Clear the dirty flag on the source layer so the next pass skips it.
    if (w.dirty !== 0) {
      world.set(w.layerEntity, TileLayer, { dirty: 0 }).unwrap();
    }
  }
}
