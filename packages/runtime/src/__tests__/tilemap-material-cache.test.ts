// tilemap-material-cache.test - resolveTilesetMaterial cache key invariants
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//   - The atlas-material cache key is the binary tuple
//     `(atlasHandle, regionIndex)` (charter P4 + plan-strategy §D-9 / §D-12).
//   - Re-spawning identical (atlas, regionIndex) pairs (across distinct
//     Tilemap entities, distinct TileLayer entities) hits the SAME
//     materialHandle on the derived MeshRenderer entity.
//   - Different regionIndex values produce DIFFERENT material handles.
//
// The cache is module-scoped inside `tilemap-chunk-extract-system.ts`;
// `resetTilemapChunkExtractCache()` clears it between scenarios.
//
// Anchors: plan-tasks m0-t9 / m0-t10; plan-strategy §D-9 cache key shape;
// charter P4 (atlases plural composite + binary cache key).

import { Entity, World } from '@forgeax/engine-ecs';
import { type Handle, type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, MeshRenderer, TileLayer, Tilemap, Transform } from '../components';
import {
  resetTilemapChunkExtractCache,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

function spawnTilemapWithLayer(
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

function makeTileset(opts: {
  guid: string;
  regions: Array<{ x: number; y: number; width: number; height: number }>;
}): TilesetAsset {
  return {
    kind: 'tileset',
    guid: opts.guid,
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: opts.regions,
    tiles: opts.regions.map((_, i) => ({ regionIndex: i })),
  };
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

describe('resolveTilesetMaterial — binary (atlasHandle, regionIndex) cache key', () => {
  it('twice-spawn the same (atlas, regionIndex) -> same materialHandle', () => {
    const world1 = new World();
    const handle1 = world1.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      makeTileset({
        guid: 'tileset/A',
        regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      }),
    );
    spawnTilemapWithLayer(world1, handle1, 1, 1, new Uint32Array([1]));
    resetTilemapChunkExtractCache();
    tilemapChunkExtractSystem(world1);
    const mats1 = readDerivedMaterialHandles(world1);
    expect(mats1.length).toBe(1);

    // Second spawn: distinct world, same atlas handle (id=101) and same
    // regionIndex => the cache key collides => same materialHandle.
    const world2 = new World();
    const handle2 = world2.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      makeTileset({
        guid: 'tileset/B',
        regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      }),
    );
    spawnTilemapWithLayer(world2, handle2, 1, 1, new Uint32Array([1]));
    tilemapChunkExtractSystem(world2);
    const mats2 = readDerivedMaterialHandles(world2);
    expect(mats2.length).toBe(1);
    expect(mats1[0]).toBe(mats2[0]);
  });

  it('different regionIndex on the same atlas -> different materialHandle', () => {
    const world = new World();
    const handle = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
      'TilesetAsset',
      makeTileset({
        guid: 'tileset/two-regions',
        regions: [
          { x: 0, y: 0, width: 16, height: 16 },
          { x: 16, y: 0, width: 16, height: 16 },
        ],
      }),
    );

    spawnTilemapWithLayer(world, handle, 2, 1, new Uint32Array([1, 2]));
    resetTilemapChunkExtractCache();
    tilemapChunkExtractSystem(world);
    const mats = readDerivedMaterialHandles(world).sort((a, b) => a - b);
    expect(mats.length).toBe(2);
    expect(mats[0]).not.toBe(mats[1]);
  });
});
