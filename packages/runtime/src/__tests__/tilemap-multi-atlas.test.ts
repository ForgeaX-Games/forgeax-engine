// tilemap-multi-atlas.test - resolveTilesetMaterial 3-hop atlasIndex routing
// + binary (atlasHandle, regionIndex) cache key invariants (feat-20260608
// M3 / m3-t6). RED at commit; m3-t7 lands the 3-hop dispatch.
//
// Spec (plan-strategy §D-7 step 2 + §D-12 + requirements §AC-04 / §AC-11):
//   resolveTilesetMaterial walks `tile.regionIndex -> regions[regionIndex]
//   -> region.atlasIndex ?? 0 -> atlases[atlasIndex]` so a TilesetAsset
//   with N atlases routes per-region to the correct GPU texture handle.
//   The material cache key stays binary `(atlasHandle, regionIndex)` --
//   different atlas handles for the same regionIndex produce distinct
//   material entries (charter P4).
//
// Charter mapping: P4 (cache key stays binary; widthCells / pivot extras
// do not leak into the key, so per-tile overrides share one material) +
// P3 (region.atlasIndex out-of-range is caught at register time via
// validateTilesetPayload m1-t6; runtime resolver bails to handle 0 if an
// atlas slot is unexpectedly empty rather than silently sampling the
// wrong texture).

import { Entity, World } from '@forgeax/engine-ecs';
import {
  type Handle,
  type MaterialAsset,
  type TilesetAsset,
  toShared,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, MeshRenderer, TileLayer, Tilemap, Transform } from '../components';
import { resolveAssetHandle } from '../resolve-asset-handle';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

interface RegionWithAtlasIndex {
  x: number;
  y: number;
  width: number;
  height: number;
  atlasIndex?: number;
}

function makeTwoAtlasTileset(opts: {
  guid: string;
  atlases: Handle<'TextureAsset', 'shared'>[];
  regions: RegionWithAtlasIndex[];
  tilesExtras?: Array<
    Partial<{ widthCells: number; heightCells: number; pivotX: number; pivotY: number }>
  >;
}): TilesetAsset {
  return {
    kind: 'tileset',
    guid: opts.guid,
    atlases: opts.atlases,
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: opts.regions,
    tiles: opts.regions.map((_, i) => ({
      regionIndex: i,
      ...(opts.tilesExtras?.[i] ?? {}),
    })),
  };
}

function spawnTilemap(
  world: World,
  tilesetHandle: Handle<'TilesetAsset', 'shared'>,
  cols: number,
  rows: number,
  tiles: Uint32Array,
) {
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols, rows, tileSizeX: 1, tileSizeY: 1, chunkSize: 4, tileset: tilesetHandle },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world.spawn(
    { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 1 } },
    { component: ChildOf, data: { parent: tilemap } },
  );
}

function readMaterialTextureHandle(world: World, materialHandle: number): number {
  const tagged = toShared<'MaterialAsset'>(materialHandle);
  const res = resolveAssetHandle<MaterialAsset>(world, tagged);
  if (!res.ok) return 0;
  const asset = res.value;
  if (asset.kind !== 'material') return 0;
  const pv = asset.paramValues as Readonly<Record<string, number | number[] | string | undefined>>;
  const tex = pv.texture;
  return typeof tex === 'number' ? tex : 0;
}

function readDerivedMaterialHandles(world: World): number[] {
  type GraphArch = {
    key: string;
    columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
  };
  const graph = (world as unknown as { _getGraph(): { archetypes: GraphArch[] } })._getGraph();
  const out: number[] = [];
  for (const arch of world.inspect().archetypes) {
    if (!arch.componentNames.includes('MeshFilter')) continue;
    if (!arch.componentNames.includes('MeshRenderer')) continue;
    if (!arch.componentNames.includes('ChildOf')) continue;
    if (!arch.componentNames.includes('Layer')) continue;
    const derived = graph.archetypes.find((a) => a.key === arch.key);
    if (!derived) continue;
    const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as Uint32Array | undefined;
    if (!entityCol) continue;
    for (let i = 0; i < entityCol.length; i++) {
      const e = entityCol[i];
      if (e === undefined || e === 0) continue;
      const renderer = world.get(e as never, MeshRenderer).unwrap();
      const materials = renderer.materials as ArrayLike<number>;
      const handle = materials[0];
      if (handle === undefined) continue;
      out.push(handle as unknown as number);
    }
  }
  return out;
}

describe('resolveTilesetMaterial - 3-hop atlasIndex routing (m3-t6)', () => {
  it('atlases=[A,B] + regions[].atlasIndex routes each region to its own atlas', () => {
    const world = new World();
    const atlasA = toShared<'TextureAsset'>(201);
    const atlasB = toShared<'TextureAsset'>(202);
    const tileset = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      makeTwoAtlasTileset({
        guid: 'tileset/multi-atlas',
        atlases: [atlasA, atlasB],
        regions: [
          { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
          { x: 0, y: 0, width: 16, height: 16, atlasIndex: 1 },
          { x: 16, y: 0, width: 16, height: 16 /* defaults to atlasIndex 0 */ },
        ],
      }),
    );

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, tileset, 3, 1, new Uint32Array([1, 2, 3]));
    tilemapChunkExtractSystem(world);

    const mats = readDerivedMaterialHandles(world);
    expect(mats.length).toBe(3);
    // All 3 handles must be distinct -- atlas A region 0 vs atlas B region 1
    // vs atlas A region 2 are three independent (atlasHandle, regionIndex)
    // cache keys.
    expect(new Set(mats).size).toBe(3);

    // The 3-hop walk must thread each region to the *correct* atlas. Build
    // a map cellX -> material -> texture so we can verify the routing.
    // tiles[0] regionIndex=0 atlasIndex=0 -> atlasA (id 201)
    // tiles[1] regionIndex=1 atlasIndex=1 -> atlasB (id 202)
    // tiles[2] regionIndex=2 (no atlasIndex, defaults to 0) -> atlasA (id 201)
    const textures = mats.map((h) => readMaterialTextureHandle(world, h));
    // Without the 3-hop, every tile would point at atlases[0] (id 201).
    expect(textures).toContain(202);
    expect(textures).toContain(201);
  });

  it('same (atlasHandle, regionIndex) hits the same cache slot even when widthCells/pivot differ', () => {
    const world = new World();
    const atlasA = toShared<'TextureAsset'>(301);
    // Two tile entries reference the SAME region 0 but carry different
    // widthCells / pivot -- the cache key is strictly (atlasHandle,
    // regionIndex), so both must share one materialHandle.
    const tileset = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', {
      kind: 'tileset',
      guid: 'tileset/shared-cache',
      atlases: [atlasA],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [
        { regionIndex: 0, widthCells: 1, heightCells: 1, pivotX: 0.5, pivotY: 0.5 },
        { regionIndex: 0, widthCells: 3, heightCells: 4, pivotX: 0.2, pivotY: 0.8 },
      ],
    });

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, tileset, 2, 1, new Uint32Array([1, 2]));
    tilemapChunkExtractSystem(world);

    const mats = readDerivedMaterialHandles(world);
    expect(mats.length).toBe(2);
    expect(mats[0]).toBe(mats[1]);
  });

  it('different atlasIndex on the same regionIndex maps to different materials', () => {
    const world = new World();
    const atlasA = toShared<'TextureAsset'>(401);
    const atlasB = toShared<'TextureAsset'>(402);

    // Region 0 (x=0,y=0) appears twice -- once on atlas A, once on atlas B.
    // The TilesetAsset has two regions sharing identical pixel coordinates
    // but distinct atlasIndex; the cache must produce two material handles.
    const tileset = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      makeTwoAtlasTileset({
        guid: 'tileset/two-atlases-same-region',
        atlases: [atlasA, atlasB],
        regions: [
          { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
          { x: 0, y: 0, width: 16, height: 16, atlasIndex: 1 },
        ],
      }),
    );

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, tileset, 2, 1, new Uint32Array([1, 2]));
    tilemapChunkExtractSystem(world);

    const mats = readDerivedMaterialHandles(world).sort((a, b) => a - b);
    expect(mats.length).toBe(2);
    expect(mats[0]).not.toBe(mats[1]);

    // One material must point at atlasA (401), the other at atlasB (402).
    const textures = mats.map((h) => readMaterialTextureHandle(world, h)).sort((a, b) => a - b);
    expect(textures).toEqual([401, 402]);
  });
});
