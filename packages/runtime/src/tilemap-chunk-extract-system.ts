// @forgeax/engine-runtime - tilemap-chunk-extract-system.
//
// Walks every TileLayer attached to a Tilemap via ChildOf; when a layer is
// dirty (or has never been extracted), purges its previously-spawned derived
// per-cell entities and re-spawns one ECS entity per non-zero cell. Each
// derived entity carries Transform + MeshFilter (HANDLE_QUAD) + MeshRenderer
// + Layer. Derived entities are root entities (no ChildOf) so propagateTransforms
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
import { type box3, frustum, mat4 } from '@forgeax/engine-math';
import {
  type Handle,
  type MaterialAsset,
  type TilesetAsset,
  type TilesetRegion,
  type TilesetTileEntry,
  unwrapHandle,
} from '@forgeax/engine-types';
import { HANDLE_QUAD } from './asset-registry';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  ChildOf,
  decodeSortScope,
  Layer,
  MeshFilter,
  MeshRenderer,
  type SortScope,
  SpriteInstances,
  TileLayer,
  Tilemap,
  Transform,
} from './components';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from './materials';
import { resolveAssetHandle } from './resolve-asset-handle';
import { decodeTileBits } from './tile-bits';

// Module-scoped caches (charter P5 — engine-side memoisation; AI users
// never reach in). Test harness can flush them via the reset helpers.
//
// Two material caches coexist because the extract system produces two
// kinds of derived entities, each with a different material-key granularity:
//
//   1. `atlasMaterialCache` — key `${atlasId}|${regionIndex}` → per-region
//      material with the UV rectangle baked into `paramValues.region`.
//      Used by the per-cell entity path (sortScope='per-cell' object
//      layers). Each tile graphic gets a distinct MaterialAsset.
//
//   2. `atlasOnlyMaterialCache` — key `${atlasId}` → per-atlas material
//      with `paramValues.region: [0,0,1,1]` placeholder. Used by the
//      SpriteInstances batched path (sortScope='layer' terrain layers).
//      The shader's PER_INSTANCE_REGION=true variant reads per-instance
//      UV from the instance buffer, not from the material UBO, so the
//      placeholder is ignored at draw time.
const atlasMaterialCache = new Map<string, number>();
const atlasOnlyMaterialCache = new Map<string, number>();
// Terrain (sortScope='layer') layers: one entry per layer, all entities.
const layerDerivedEntities = new Map<number, number[]>();
const layerEverBuilt = new Set<number>();

// ─── Chunk-streaming state for sortScope='per-cell' (object) layers ───────
//
// Object layers stream per-chunk: only chunks whose world AABB intersects the
// camera frustum have per-cell entities alive in the ECS world. This keeps
// extractFrame's entity count proportional to visible tile count rather than
// total map tile count (charter P5: engine-side memoisation / streaming).
//
// Design:
//   layerStreamCache : layerKey → pre-bucketed specs by chunkIndex (built once
//                      from bucketTileLayer, rebuilt on dirty). Avoids re-reading
//                      the full tileset and re-materialising every frame.
//   layerChunkStreamEntities : "${layerKey}:${chunkIdx}" → spawned entity ids
//                      for that chunk (purged when chunk leaves frustum).
//   layerChunkActive : layerKey → Set<chunkIdx> currently spawned.
interface StreamLayerCache {
  readonly byChunk: ReadonlyMap<number, readonly DerivedSpawnSpec[]>;
  readonly tilemap: {
    readonly cols: number;
    readonly rows: number;
    readonly tileSizeX: number;
    readonly tileSizeY: number;
    readonly chunkSize: number;
  };
  readonly layerOrder: number;
  readonly sortScope: SortScope;
}
const layerStreamCache = new Map<number, StreamLayerCache>();
const layerChunkStreamEntities = new Map<string, number[]>();
const layerChunkActive = new Map<number, Set<number>>();

/**
 * Flush both material caches. Useful in test harnesses + after a
 * TilesetAsset reload.
 */
export function resetTilemapChunkExtractCache(): void {
  atlasMaterialCache.clear();
  atlasOnlyMaterialCache.clear();
}

/**
 * Flush the per-layer derived-entity tracker + the first-frame heuristic
 * set. Useful in test harnesses + when the World is re-created.
 */
export function resetTilemapDerivedEntityTracker(): void {
  layerDerivedEntities.clear();
  layerEverBuilt.clear();
  layerStreamCache.clear();
  layerChunkStreamEntities.clear();
  layerChunkActive.clear();
}

/**
 * Compute the per-layer / per-chunk packed value carried in `Layer.value`
 * on derived entities. `sortScope` is the closed string union from
 * `TileLayer.sortScope`:
 *   - `'layer'`    (default): `(layerOrder << 20) | (chunkIndex & 0xFFFFF)` —
 *                  terrain semantics, layerOrder dominates with chunkIndex
 *                  tiebreak within the layer.
 *   - `'per-cell'`: returns `(layerOrder << 20)` (chunkIndex folded to 0)
 *                  so every derived entity in the layer shares one
 *                  Layer.value and can Y-interleave with sprite entities
 *                  carrying the same value (e.g. a player sprite riding
 *                  `SPRITE_LAYER_VALUE = layerOrder << 20`).
 *
 * Round-2 rename (D-V-3): the third arg was `ySort: boolean` before the
 * sortScope union landed; it is now the closed `SortScope` union with
 * default `'layer'`. The 0x200000 / chunked-bits semantics for the two
 * arms are preserved exactly so existing pixel-parity baselines stay
 * stable (only the AI-user surface widens to a self-documenting literal).
 */
export function encodeTilemapLayerValue(
  layerOrder: number,
  chunkIndex: number,
  sortScope: SortScope = 'layer',
): number {
  if (sortScope === 'per-cell') return (layerOrder << 20) | 0;
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
  // pixel extent comes from atlasSizes[atlasIndex] when present (exact
  // per-atlas pixel dimensions); falls back to columns * tileWidth for
  // single-atlas or legacy callers.
  const atlasSize = tileset.atlasSizes?.[atlasIndex];
  const atlasWidth = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelWidth : tileset.columns * tileset.tileWidth,
  );
  const atlasHeight = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelHeight : tileset.rows * tileset.tileHeight,
  );
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
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      },
    ],
    paramValues: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: atlasHandle,
      region: [u, v, w, h],
      pivotAndSize: [0.5, 0.5, 1.0, 1.0],
      flipY: 1.0,
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

/**
 * Resolve an atlas-only sprite material (no baked-in UV region). One
 * material per atlas — used by the SpriteInstances batched draw path
 * (sortScope='layer'). The per-instance UV region rectangle lives in the
 * `SpriteInstances.regions` buffer instead of in the material UBO.
 *
 * `paramValues.region` is a `[0, 0, 1, 1]` placeholder. The sprite shader's
 * `PER_INSTANCE_REGION=true` variant reads region from
 * `instances[idx].region` and ignores the material slot; selecting that
 * variant is the record stage's responsibility (see
 * `render-system-record.ts` sprite pass pipeline selection).
 *
 * Returns the registered MaterialAsset slot id (unwrapped Handle u32) or
 * 0 if the atlas slot is empty (charter P3 fail-safe; mirrors
 * `resolveTilesetMaterial`).
 */
function resolveAtlasOnlyMaterial(world: World, tileset: TilesetAsset, atlasIndex: number): number {
  const atlasHandle = tileset.atlases[atlasIndex];
  if (atlasHandle === undefined) return 0;
  const atlasId = unwrapHandle(atlasHandle as unknown as Handle<'TextureAsset', 'shared'>);
  const cacheKey = String(atlasId);
  const cached = atlasOnlyMaterialCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const matPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      },
    ],
    paramValues: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: atlasHandle,
      region: [0.0, 0.0, 1.0, 1.0],
      pivotAndSize: [0.5, 0.5, 1.0, 1.0],
      flipY: 1.0,
    },
  };
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    matPayload,
  );
  const id = unwrapHandle(matHandle);
  atlasOnlyMaterialCache.set(cacheKey, id);
  return id;
}

/**
 * Compute the half-texel-inset normalised UV rectangle for a TilesetRegion
 * (atlas-space pixels → atlas-normalised [u, v, w, h]). Mirrors the inset
 * computation inside `resolveTilesetMaterial` so the per-instance region
 * data fed into `SpriteInstances.regions` produces pixel-identical sampling
 * to the per-region material path (charter P4 consistent abstraction).
 */
function computeRegionUv(
  tileset: TilesetAsset,
  region: TilesetRegion,
  atlasIndex: number,
): [u: number, v: number, w: number, h: number] {
  const atlasSize = tileset.atlasSizes?.[atlasIndex];
  const atlasWidth = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelWidth : tileset.columns * tileset.tileWidth,
  );
  const atlasHeight = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelHeight : tileset.rows * tileset.tileHeight,
  );
  const halfTexelU = 0.5 / atlasWidth;
  const halfTexelV = 0.5 / atlasHeight;
  return [
    region.x / atlasWidth + halfTexelU,
    region.y / atlasHeight + halfTexelV,
    region.width / atlasWidth - 2 * halfTexelU,
    region.height / atlasHeight - 2 * halfTexelV,
  ];
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
  // Atlas + region indices retained so the SpriteInstances (sortScope=
  // 'layer') path can group cells by atlas and look up per-instance UV
  // without re-walking the 3-hop chain `tileId → regions → atlasIndex`.
  readonly atlasIndex: number;
  readonly regionIndex: number;
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
  entry: TilesetTileEntry,
  atlasIndex: number,
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
    atlasIndex,
    regionIndex: entry.regionIndex,
  };
}

/**
 * Compute the post-flip TRS components for one tile cell. The plan-strategy
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
 * Single SSOT consumed by both the per-cell entity spawn path and the
 * SpriteInstances batched path so the two routes produce pixel-identical
 * world transforms (charter P4 consistent abstraction).
 */
function computeTileTrs(
  tilemap: { tileSizeX: number; tileSizeY: number },
  spec: DerivedSpawnSpec,
  packedTile: number,
): {
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
} {
  const { flipH, flipV, flipDiagonal } = decodeTileBits(packedTile);
  const basePivotForX = flipDiagonal ? spec.pivotY : spec.pivotX;
  const effectivePivotX = flipH ? 1 - basePivotForX : basePivotForX;
  const effectivePivotY = effectivePivotYForTilemapFlip(
    spec.pivotY,
    spec.pivotX,
    flipV,
    flipDiagonal,
  );
  return {
    posX:
      (spec.cellX + effectivePivotX + (0.5 - effectivePivotX) * spec.widthCells) *
      tilemap.tileSizeX,
    posY:
      (spec.cellY + effectivePivotY + (0.5 - effectivePivotY) * spec.heightCells) *
      tilemap.tileSizeY,
    scaleX: (flipH ? -1 : 1) * spec.widthCells * tilemap.tileSizeX,
    scaleY: (flipV ? -1 : 1) * spec.heightCells * tilemap.tileSizeY,
    quatZ: flipDiagonal ? SQRT1_2 : 0,
    quatW: flipDiagonal ? SQRT1_2 : 1,
  };
}

/**
 * Spawn a single derived per-cell render entity. Used by the per-cell
 * sortScope path (`sortScope='per-cell'`, object layers) where each cell
 * needs an independent Y-sort position to interleave with sprite entities
 * (e.g. player) at arbitrary Y positions.
 */
function spawnDerivedRenderEntities(
  world: World,
  tilemap: { tileSizeX: number; tileSizeY: number },
  layerOrder: number,
  spec: DerivedSpawnSpec,
  packedTile: number,
  sortScope: SortScope = 'layer',
): EntityHandle {
  const { posX, posY, scaleX, scaleY, quatZ, quatW } = computeTileTrs(tilemap, spec, packedTile);
  const layerValue = encodeTilemapLayerValue(layerOrder, spec.chunkIndex, sortScope);
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
    )
    .unwrap();
}

/**
 * Spawn one batched SpriteInstances entity per (TileLayer, chunk, atlas)
 * group. Used by the `sortScope='layer'` path (terrain layers): every
 * cell in the group becomes one instance in the same drawIndexed call.
 *
 * The chunk grid is the unit declared by `Tilemap.chunkSize` (default
 * 16x16). One SpriteInstances entity per (chunk, atlas) pair keeps each
 * GPU instance buffer small (256 cells x 80B = 20KB worst case) and lets
 * downstream frustum culling / incremental rebuild operate at chunk
 * granularity (industry standard: Godot quadrant_size, Bevy ChunkSize,
 * Tiled TMX chunks).
 *
 * Layout:
 *   - Transform: identity (the per-instance mat4 carries world-space TRS).
 *   - MeshFilter: HANDLE_QUAD.
 *   - MeshRenderer: atlas-only sprite material (region placeholder; shader
 *     reads per-instance UV from SpriteInstances.regions under the
 *     PER_INSTANCE_REGION=true variant — selected at record stage).
 *   - SpriteInstances: { transforms: Float32Array(N*16),
 *                        regions:    Float32Array(N*4) }.
 *   - Layer: encodeTilemapLayerValue(layerOrder, chunkIndex, 'layer').
 *     chunkIndex distinguishes adjacent chunks of the same layer in the
 *     transparent-sort key so the back-to-front ordering between chunks
 *     remains stable (chunks within a layer don't visually overlap in
 *     normal tilemap scenes; the chunkIndex tiebreaker is byte-exact
 *     with the per-cell path's encoding).
 *
 * Returns the spawned EntityHandle. Empty groups (zero cells) short-circuit
 * and return `undefined`.
 */
function spawnSpriteInstancesGroup(
  world: World,
  tilemap: { cols: number; tileSizeX: number; tileSizeY: number; chunkSize: number },
  tileset: TilesetAsset,
  layerOrder: number,
  chunkIndex: number,
  atlasIndex: number,
  materialHandle: number,
  cellSpecs: readonly DerivedSpawnSpec[],
): EntityHandle | undefined {
  if (cellSpecs.length === 0) return undefined;
  const N = cellSpecs.length;
  const transforms = new Float32Array(N * 16);
  const regions = new Float32Array(N * 4);
  const tmpMat = new Float32Array(16) as unknown as Parameters<typeof mat4.compose>[0];
  const tmpF = tmpMat as unknown as Float32Array;
  const tmpT: [number, number, number] = [0, 0, 0];
  const tmpR: [number, number, number, number] = [0, 0, 0, 1];
  const tmpS: [number, number, number] = [1, 1, 1];

  // Per-chunk frustum cull: entity Transform = chunk world center + chunk
  // extents (scaleX/Y). The frustum culler reads the entity AABB (HANDLE_QUAD
  // local [-0.5, 0.5]² expanded by entity scale/pos) → world AABB exactly
  // covers the chunk footprint.
  //
  // Per-instance transforms become chunk-local: inv_chunk * world_tile.
  // inv_chunk is a pure TRS-inverse (no rotation), so for each column c of
  // the world mat W:
  //   local[c*4+0] = (W[c*4+0] - chunkCenterX * W[c*4+3]) * invSX
  //   local[c*4+1] = (W[c*4+1] - chunkCenterY * W[c*4+3]) * invSY
  //   local[c*4+2] = W[c*4+2]
  //   local[c*4+3] = W[c*4+3]
  // The sprite shader then produces:
  //   world = chunk_TRS * local_tile * pos_local
  //         = chunk_TRS * (inv_chunk * world_tile) * pos_local
  //         = world_tile * pos_local  ✓ (pixel-identical to identity path)
  //
  // Tiles whose widthCells/heightCells straddle a chunk boundary will have
  // instance transforms that exceed the chunk AABB; the entity is still drawn
  // (conservative cull only skips when the chunk AABB is fully outside).
  const chunksPerRow = Math.max(1, Math.ceil(tilemap.cols / tilemap.chunkSize));
  const chunkX = chunkIndex % chunksPerRow;
  const chunkY = Math.floor(chunkIndex / chunksPerRow);
  const chunkScaleX = tilemap.chunkSize * tilemap.tileSizeX;
  const chunkScaleY = tilemap.chunkSize * tilemap.tileSizeY;
  const chunkCenterX = (chunkX + 0.5) * chunkScaleX;
  const chunkCenterY = (chunkY + 0.5) * chunkScaleY;
  const invSX = chunkScaleX > 0 ? 1 / chunkScaleX : 1;
  const invSY = chunkScaleY > 0 ? 1 / chunkScaleY : 1;

  for (let i = 0; i < N; i++) {
    const spec = cellSpecs[i] as DerivedSpawnSpec;
    const { posX, posY, scaleX, scaleY, quatZ, quatW } = computeTileTrs(
      tilemap,
      spec,
      spec.packedTile,
    );
    tmpT[0] = posX;
    tmpT[1] = posY;
    tmpT[2] = 0;
    tmpR[0] = 0;
    tmpR[1] = 0;
    tmpR[2] = quatZ;
    tmpR[3] = quatW;
    tmpS[0] = scaleX;
    tmpS[1] = scaleY;
    tmpS[2] = 1;
    mat4.compose(tmpMat, tmpT, tmpR, tmpS);

    // Write chunk-local transform: inv_chunk * world_tile (see formula above).
    const dst = i * 16;
    for (let c = 0; c < 4; c++) {
      const base = c * 4;
      const w3 = tmpF[base + 3] as number;
      transforms[dst + base + 0] = ((tmpF[base + 0] as number) - chunkCenterX * w3) * invSX;
      transforms[dst + base + 1] = ((tmpF[base + 1] as number) - chunkCenterY * w3) * invSY;
      transforms[dst + base + 2] = tmpF[base + 2] as number;
      transforms[dst + base + 3] = w3;
    }

    const region = tileset.regions[spec.regionIndex];
    if (region !== undefined) {
      const [u, v, w, h] = computeRegionUv(tileset, region, atlasIndex);
      regions[i * 4 + 0] = u;
      regions[i * 4 + 1] = v;
      regions[i * 4 + 2] = w;
      regions[i * 4 + 3] = h;
    }
  }

  const layerValue = encodeTilemapLayerValue(layerOrder, chunkIndex, 'layer');
  // plan-strategy D-2: the SpriteInstances entity's Transform.posY is set
  // to `chunkCenterY` (becomes `world[13]` in the entity's local-to-world
  // matrix). This is the LAYER_Y fold sort key — terrain rows share a
  // chunk Y, so per-chunk Y resolution is exactly the granularity the
  // fold pass needs. Per-tile world[13] (instance-level) is intentionally
  // _not_ used; instances live in the chunk-local space anchored at
  // chunkCenterY (see line 601-647 above). This is intentional, not a bug.
  return world
    .spawn(
      {
        component: Transform,
        data: {
          posX: chunkCenterX,
          posY: chunkCenterY,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: chunkScaleX,
          scaleY: chunkScaleY,
          scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      {
        component: MeshRenderer,
        data: {
          materials: [materialHandle as unknown as Handle<'MaterialAsset', 'shared'>],
        },
      },
      { component: SpriteInstances, data: { transforms, regions } },
      { component: Layer, data: { value: layerValue } },
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
      readonly sortScope: SortScope;
      readonly tileset: TilesetAsset;
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
  const sortScope = decodeSortScope(layer.sortScope);

  // sortScope='layer' (terrain) uses the SpriteInstances batched path which
  // groups cells by atlas under an atlas-only material; sortScope='per-cell'
  // (object) keeps the per-cell entity path with per-region materials so
  // each cell can interleave with sprites by foot-Y. The material resolver
  // selection here keeps the spec's `materialHandle` in the correct
  // granularity for whichever spawn path consumes it downstream.
  const useSpriteInstances = sortScope === 'layer';

  const specs: DerivedSpawnSpec[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const packed = tiles[i] ?? 0;
    if (packed === 0) continue;
    const { tileId } = decodeTileBits(packed);
    if (tileId === 0) continue;
    const entry = tileset.tiles[tileId - 1];
    if (entry === undefined) continue;
    const region = tileset.regions[entry.regionIndex];
    if (region === undefined) continue;
    const atlasIndex = region.atlasIndex ?? 0;
    const materialHandle = useSpriteInstances
      ? resolveAtlasOnlyMaterial(world, tileset, atlasIndex)
      : resolveTilesetMaterial(world, tileset, entry.regionIndex);
    const spec = specFor(
      tilemap.cols,
      tilemap.chunkSize,
      i,
      packed,
      materialHandle,
      entry,
      atlasIndex,
    );
    specs.push(spec);
  }
  return {
    tilemap,
    layerOrder: layer.layerOrder,
    sortScope,
    tileset,
    specs,
  };
}

/**
 * Compute the camera frustum planes for the first Camera + Transform entity
 * found in the world. Returns null when no camera exists or the projection
 * parameters are degenerate (callers treat null as always-visible).
 *
 * Mirrors the frustum-plane computation in render-system-extract so both
 * cull paths use byte-identical planes (charter P4 consistent abstraction).
 */
function buildCameraFrustumPlanes(world: World): frustum.Frustum | null {
  const q = createQueryState({ with: [Camera, Transform, Entity] });
  let result: frustum.Frustum | null = null;
  queryRun(q, world, (bundle) => {
    if (result !== null) return;
    const entitySelf = bundle.Entity.self as unknown as Uint32Array;
    if (entitySelf.length === 0) return;
    const camEntity = entitySelf[0] as EntityHandle;

    const camRes = world.get(camEntity, Camera);
    const trRes = world.get(camEntity, Transform);
    if (!camRes.ok || !trRes.ok) return;

    const cam = camRes.value as unknown as {
      near: number;
      far: number;
      projection: number;
      left: number;
      right: number;
      bottom: number;
      top: number;
      fov: number;
      aspect: number;
    };
    const tr = trRes.value as unknown as { world: Float32Array };

    const { near, far } = cam;
    if (near >= far) return;

    const proj = mat4.create();
    if (cam.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
      mat4.orthographic(
        proj as Parameters<typeof mat4.orthographic>[0],
        cam.left,
        cam.right,
        cam.bottom,
        cam.top,
        near,
        far,
      );
    } else {
      mat4.perspective(
        proj as Parameters<typeof mat4.perspective>[0],
        cam.fov,
        cam.aspect,
        near,
        far,
      );
    }
    const view = mat4.create();
    mat4.invert(
      view as Parameters<typeof mat4.invert>[0],
      tr.world as Parameters<typeof mat4.invert>[1],
    );
    const vp = mat4.create();
    mat4.multiply(
      vp as Parameters<typeof mat4.multiply>[0],
      proj as Parameters<typeof mat4.multiply>[1],
      view as Parameters<typeof mat4.multiply>[2],
    );
    const f = frustum.create();
    frustum.fromViewProjection(f, vp as Parameters<typeof frustum.fromViewProjection>[1]);
    result = f;
  });
  return result;
}

/**
 * World-space AABB [minX, minY, minZ, maxX, maxY, maxZ] for a chunk.
 * Z is expanded to ±1 so flat tile geometry (z=0) is never degenerate.
 */
function chunkWorldAabb(
  chunkIndex: number,
  cols: number,
  chunkSize: number,
  tileSizeX: number,
  tileSizeY: number,
): box3.Box3Like {
  const chunksPerRow = Math.max(1, Math.ceil(cols / chunkSize));
  const cx = chunkIndex % chunksPerRow;
  const cy = Math.floor(chunkIndex / chunksPerRow);
  const x0 = cx * chunkSize * tileSizeX;
  const y0 = cy * chunkSize * tileSizeY;
  return [
    x0,
    y0,
    -1,
    x0 + chunkSize * tileSizeX,
    y0 + chunkSize * tileSizeY,
    1,
  ] as unknown as box3.Box3Like;
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
 * into derived render entities. Called per-frame from `createRenderer.draw`
 * before the render system reads the world.
 *
 * Two paths based on `TileLayer.sortScope`:
 *
 *   `'layer'` (terrain, default):
 *     Batched SpriteInstances path — spawned once, reused until dirty. Each
 *     (chunk, atlas) pair becomes one SpriteInstances entity whose Transform
 *     covers the chunk footprint, so the frustum culler rejects off-screen
 *     chunks at entity granularity.
 *
 *   `'per-cell'` (object layers):
 *     Chunk-streaming path — specs are bucketed by chunkIndex once (rebuilt
 *     on dirty) and the live entity set is updated every frame to match the
 *     camera frustum. Only chunks whose world AABB intersects the frustum
 *     have ECS entities alive, keeping `extractFrame` iteration proportional
 *     to visible tile count rather than total map tile count.
 */
export function tilemapChunkExtractSystem(world: World): void {
  type LayerWork = {
    readonly layerEntity: EntityHandle;
    readonly parentEntity: EntityHandle;
    readonly dirty: number;
    readonly sortScopeRaw: number;
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
        sortScopeRaw: layerBundle.sortScope?.[i] ?? 0,
      });
    }
  });

  // Compute the camera frustum once per frame — only needed when at least
  // one streaming (per-cell) layer exists. Null = always-visible fallback.
  let frustumPlanes: frustum.Frustum | null | undefined;

  for (const w of work) {
    const layerKey = unwrapHandle(w.layerEntity as unknown as Handle<string, 'shared'>);
    // AC-04: decode via the canonical SortScope union; avoid relying on the
    // raw encoding (0='layer', 1='per-cell') leaking through this call site.
    // `decodeSortScope` is the SSOT used throughout `bucketTileLayer` (see
    // line 730); this main-loop branch is the last remaining numeric check.
    const isStreaming = decodeSortScope(w.sortScopeRaw) === 'per-cell';

    if (!isStreaming) {
      // ── Terrain batched path (sortScope='layer') ──────────────────────
      // Spawn once per dirty; entity AABB covers the chunk footprint for
      // entity-level frustum culling in render-system-extract.
      const everBuilt = layerEverBuilt.has(layerKey);
      if (everBuilt && w.dirty === 0) continue;

      purgeDerivedEntities(world, w.layerEntity);

      const bucket = bucketTileLayer(world, w.layerEntity, w.parentEntity);
      if (bucket === undefined) {
        layerEverBuilt.add(layerKey);
        continue;
      }

      const spawned: number[] = [];
      const byChunkAtlas = new Map<number, DerivedSpawnSpec[]>();
      for (const spec of bucket.specs) {
        const key = ((spec.chunkIndex & 0xfffff) << 16) | (spec.atlasIndex & 0xffff);
        const list = byChunkAtlas.get(key);
        if (list === undefined) {
          byChunkAtlas.set(key, [spec]);
        } else {
          list.push(spec);
        }
      }
      for (const groupSpecs of byChunkAtlas.values()) {
        const first = groupSpecs[0];
        if (first === undefined) continue;
        const e = spawnSpriteInstancesGroup(
          world,
          bucket.tilemap,
          bucket.tileset,
          bucket.layerOrder,
          first.chunkIndex,
          first.atlasIndex,
          first.materialHandle,
          groupSpecs,
        );
        if (e !== undefined) {
          spawned.push(unwrapHandle(e as unknown as Handle<string, 'shared'>));
        }
      }
      layerDerivedEntities.set(layerKey, spawned);
      layerEverBuilt.add(layerKey);
      if (w.dirty !== 0) {
        world.set(w.layerEntity, TileLayer, { dirty: 0 }).unwrap();
      }
      continue;
    }

    // ── Object streaming path (sortScope='per-cell') ───────────────────
    // Step 1: rebuild specs cache when dirty or first time.
    if (w.dirty !== 0 || !layerStreamCache.has(layerKey)) {
      // Despawn all currently-active chunks for this layer.
      const activeSet = layerChunkActive.get(layerKey);
      if (activeSet !== undefined) {
        for (const chunkIdx of activeSet) {
          const key = `${layerKey}:${chunkIdx}`;
          const entities = layerChunkStreamEntities.get(key);
          if (entities !== undefined) {
            for (const e of entities) world.despawn(e as EntityHandle);
            layerChunkStreamEntities.delete(key);
          }
        }
        activeSet.clear();
      }
      layerStreamCache.delete(layerKey);

      const bucket = bucketTileLayer(world, w.layerEntity, w.parentEntity);
      if (bucket !== undefined) {
        const byChunk = new Map<number, DerivedSpawnSpec[]>();
        for (const spec of bucket.specs) {
          const list = byChunk.get(spec.chunkIndex);
          if (list === undefined) {
            byChunk.set(spec.chunkIndex, [spec]);
          } else {
            list.push(spec);
          }
        }
        layerStreamCache.set(layerKey, {
          byChunk,
          tilemap: bucket.tilemap,
          layerOrder: bucket.layerOrder,
          sortScope: bucket.sortScope,
        });
      }
      if (w.dirty !== 0) {
        world.set(w.layerEntity, TileLayer, { dirty: 0 }).unwrap();
      }
    }

    const cache = layerStreamCache.get(layerKey);
    if (cache === undefined) continue;

    // Step 2: lazy-compute camera frustum on first streaming layer.
    if (frustumPlanes === undefined) {
      frustumPlanes = buildCameraFrustumPlanes(world);
    }

    // Step 3: diff visible chunks against active set.
    const activeSet = layerChunkActive.get(layerKey) ?? new Set<number>();
    layerChunkActive.set(layerKey, activeSet);
    const { tilemap } = cache;

    for (const [chunkIdx, specs] of cache.byChunk) {
      const aabb = chunkWorldAabb(
        chunkIdx,
        tilemap.cols,
        tilemap.chunkSize,
        tilemap.tileSizeX,
        tilemap.tileSizeY,
      );
      const visible = frustumPlanes === null || frustum.intersectsBox(frustumPlanes, aabb);
      const wasActive = activeSet.has(chunkIdx);

      if (visible && !wasActive) {
        // Spawn per-cell entities for this newly-visible chunk.
        const spawned: number[] = [];
        for (const spec of specs) {
          const e = spawnDerivedRenderEntities(
            world,
            tilemap,
            cache.layerOrder,
            spec,
            spec.packedTile,
            cache.sortScope,
          );
          spawned.push(unwrapHandle(e as unknown as Handle<string, 'shared'>));
        }
        layerChunkStreamEntities.set(`${layerKey}:${chunkIdx}`, spawned);
        activeSet.add(chunkIdx);
      } else if (!visible && wasActive) {
        // Despawn per-cell entities for this newly-invisible chunk.
        const key = `${layerKey}:${chunkIdx}`;
        const entities = layerChunkStreamEntities.get(key);
        if (entities !== undefined) {
          for (const e of entities) world.despawn(e as EntityHandle);
          layerChunkStreamEntities.delete(key);
        }
        activeSet.delete(chunkIdx);
      }
    }
  }
}
