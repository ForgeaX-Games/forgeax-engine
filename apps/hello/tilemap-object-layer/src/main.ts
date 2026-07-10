// hello-tilemap-object-layer demo entry (feat-20260608 M3 / m3-t10).
//
// Directed 5-sub-scene fixture for the per-entity tilemap path. The dawn-node
// pixel readback gate in scripts/smoke-dawn.mjs drives the same world graph
// and samples one (x, y) point per sub-scene (charter P5 producer/consumer
// split: this browser entry exists for dev/preview; the headless gate owns
// the directed assertions).
//
// Sub-scene roster (cellY layout from low Y = far in world to high Y = near):
//   (a) chunk-boundary z-fight   — cellY=4..7,   two 3x4 large trees at
//       cellX=15 and cellX=17 spanning the chunkSize=16 chunk boundary.
//   (b) flip x pivot             — cellY=10..12, four 2x3 mid trees at
//       cellX=5/8/11/14 each carrying a different flip code (none/H/V/HV)
//       with pivotY=0.2 (non-center, AC-10 anchor).
//   (c) multi-atlas              — cellY=16..17, atlasA bush (1x2) at cellX=15
//       + atlasB stone (2x2) at cellX=17 (AC-11 anchor).
//   (d) unit-cell baseline       — cellY=22..23, 1x1 grass floor across
//       cellX=2..6 (hello-tilemap parity; AC-14 falsifier).
//   (e) sprite x tilemap world-Y — cellY=28..31, one 3x4 large tree at
//       cellX=15 + one standalone sprite entity at world (16, 28.5) that
//       must Y-sort through the same TransparentEntry queue (AC-13 anchor).
//
// Atlas synthesis: charter P5 — no forgeax-engine-assets PNG dependency.
// The two atlas TextureAsset handles registered here are unmanaged
// placeholders (mirrors hello-tilemap M0's `toManaged('TextureAsset')(N)`
// shape; the M3 directed gate verifies the extract system + per-entity
// sort key + multi-atlas 3-hop route through derivedCount + onError
// signals rather than RGB pixel correctness against committed PNGs).
//
// Anchors: plan-tasks m3-t10; plan-strategy section D-5 + section D-10
// (directed fixture mount); requirements AC-10 / AC-11 / AC-12 / AC-13 /
// AC-14; plan-decisions L-1 (sub-scene (e) sprite interleave).

import { World } from '@forgeax/engine-ecs';
import {
  toShared,
  type Handle,
  type MaterialAsset,
  type SamplerAsset,
  type TilesetAsset,
} from '@forgeax/engine-types';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera, ChildOf, MeshFilter, MeshRenderer, SPRITE_PREMULTIPLIED_ALPHA_BLEND, TileLayer, Tilemap, Transform, createRenderer } from '@forgeax/engine-runtime';

const COLS = 32;
const ROWS = 32;
const CHUNK_SIZE = 16;

// Tile id roster (1-indexed into TilesetAsset.tiles[]).
const TILE_GRASS = 1; // 1x1, atlasA, sub-scene (d)
const TILE_BIG_TREE = 2; // 3x4, atlasA, sub-scenes (a) + (e)
const TILE_MID_TREE = 3; // 2x3, atlasA, sub-scene (b), pivotY=0.2
const TILE_BUSH = 4; // 1x2, atlasA, sub-scene (c) left
const TILE_STONE = 5; // 2x2, atlasB, sub-scene (c) right

function buildAnchorTiles(): Uint32Array {
  const tiles = new Uint32Array(COLS * ROWS);
  // Sub-scene (a) chunk-boundary z-fight: two 3x4 big trees spanning chunk
  // boundary at cellX=16. Anchor on the bottom-left cell of each quad.
  tiles[7 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  tiles[7 * COLS + 17] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);

  // Sub-scene (b) flip x pivot: 4 mid trees at cellY=12 (bottom of 2x3 quad).
  // 4 flip codes: none / H / V / HV.
  tiles[12 * COLS + 5] = encodeTileBits(TILE_MID_TREE, false, false, false, false);
  tiles[12 * COLS + 8] = encodeTileBits(TILE_MID_TREE, true, false, false, false);
  tiles[12 * COLS + 11] = encodeTileBits(TILE_MID_TREE, false, true, false, false);
  tiles[12 * COLS + 14] = encodeTileBits(TILE_MID_TREE, true, true, false, false);

  // Sub-scene (c) multi-atlas: atlasA bush (1x2) + atlasB stone (2x2).
  // Anchor bushAnchor on cellY=17 (bottom of 1x2); stone on cellY=17 (bottom of 2x2).
  tiles[17 * COLS + 15] = encodeTileBits(TILE_BUSH, false, false, false, false);
  tiles[17 * COLS + 17] = encodeTileBits(TILE_STONE, false, false, false, false);

  // Sub-scene (d) unit-cell baseline: grass floor across cellX=2..6, cellY=22..23.
  for (let cx = 2; cx <= 6; cx++) {
    tiles[22 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
    tiles[23 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
  }

  // Sub-scene (e) sprite x tilemap world-Y interleave: one 3x4 big tree at
  // cellX=15, anchor on cellY=31 (bottom of 3x4 quad). Sprite entity is spawned
  // separately below at world (16, 28.5).
  tiles[31 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  return tiles;
}

function makeTilesetAsset(
  atlasA: Handle<'TextureAsset', 'shared'>,
  atlasB: Handle<'TextureAsset', 'shared'>,
): TilesetAsset {
  return {
    kind: 'tileset',
    guid: 'hello-tilemap-object-layer/tileset',
    atlases: [atlasA, atlasB],
    tileWidth: 16,
    tileHeight: 16,
    columns: 4,
    rows: 4,
    regions: [
      // region 0: grass (atlasA)
      { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
      // region 1: big tree (atlasA, 48x64 region for visual reference)
      { x: 16, y: 0, width: 48, height: 64, atlasIndex: 0 },
      // region 2: mid tree (atlasA, 32x48)
      { x: 16, y: 0, width: 32, height: 48, atlasIndex: 0 },
      // region 3: bush (atlasA, 16x32)
      { x: 0, y: 16, width: 16, height: 32, atlasIndex: 0 },
      // region 4: stone (atlasB, 32x32) — atlasIndex=1 routes through 3-hop
      { x: 0, y: 0, width: 32, height: 32, atlasIndex: 1 },
    ],
    tiles: [
      // tile 1 = grass: 1x1, center pivot
      { regionIndex: 0 },
      // tile 2 = big tree: 3x4, foot pivot (pivotY=0.2)
      { regionIndex: 1, widthCells: 3, heightCells: 4, pivotX: 0.5, pivotY: 0.2 },
      // tile 3 = mid tree: 2x3, foot pivot (pivotY=0.2) — AC-10 anchor
      { regionIndex: 2, widthCells: 2, heightCells: 3, pivotX: 0.5, pivotY: 0.2 },
      // tile 4 = bush: 1x2, foot pivot (pivotY=0.3)
      { regionIndex: 3, widthCells: 1, heightCells: 2, pivotX: 0.5, pivotY: 0.3 },
      // tile 5 = stone (atlasB): 2x2, center pivot
      { regionIndex: 4, widthCells: 2, heightCells: 2, pivotX: 0.5, pivotY: 0.5 },
    ],
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null;
  if (canvas === null) return;
  const renderer = await createRenderer(canvas, {});
  const ready = await renderer.ready;
  if (!ready.ok) {
    // eslint-disable-next-line no-console
    console.error('[hello-tilemap-object-layer] renderer.ready failed:', ready.error.code);
    return;
  }
  const world = new World();

  // charter P5: in-process atlas synthesis — placeholder handles (matches
  // hello-tilemap M0; the dawn smoke verifies extract-system invariants,
  // not RGB fidelity against committed PNGs).
  const atlasA = toShared<'TextureAsset'>(201);
  const atlasB = toShared<'TextureAsset'>(202);
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
    'TilesetAsset',
    makeTilesetAsset(atlasA, atlasB),
  );

  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: {
          cols: COLS,
          rows: ROWS,
          tileSize: [1, 1],
          chunkSize: CHUNK_SIZE,
          tileset: tilesetHandle,
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();

  world
    .spawn(
      { component: TileLayer, data: { tiles: buildAnchorTiles(), layerOrder: 0, dirty: 1 } },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();

  // Sub-scene (e) sprite entity for world-Y interleave with the cellY=28 big
  // tree. Needs a sprite material — register a lightweight placeholder so the
  // entity rides the sprite-bucket TransparentEntry queue alongside tilemap-
  // spawned per-cell entities (AC-13 anchor; plan-decisions L-1).
  const samplerHandle = world.allocSharedRef<'SamplerAsset', SamplerAsset>('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const spriteMaterialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    {
      kind: 'material',
      passes: [
        // feat-20260626-sprite-transparent-collapse M3 — post M1/M2 SSOT:
        // `renderState.blend` drives LDR split + premultiplied-alpha
        // pipeline routing (preset `SPRITE_PREMULTIPLIED_ALPHA_BLEND`).
        { name: 'Forward', shader: 'forgeax::sprite', tags: { LightMode: 'Forward' }, queue: 3000, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND } },
      ],
      paramValues: {
        // feat-20260625 M3 / w11 (D-4): UBO-aligned field names 1:1 with
        // sprite.wgsl.meta.json paramSchema.
        colorTint: [1, 1, 1, 1],
        baseColorTexture: atlasA,
        sampler: samplerHandle,
        region: [0, 0, 1, 1],
        pivotAndSize: [0.5, 0.5, 1, 1],
      },
    },
  );
  world
    .spawn(
      { component: Transform, data: { pos: [16.5, 28.5, 0]} },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [spriteMaterialHandle] } },
    )
    .unwrap();

  // Orthographic camera framing 0..COLS x 0..ROWS world bounds.
  world.spawn(
    { component: Transform, data: { pos: [COLS / 2, ROWS / 2, 10]} },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: canvas.width / canvas.height,
        near: 0.1,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -COLS / 2,
        right: COLS / 2,
        bottom: -ROWS / 2,
        top: ROWS / 2,
      },
    },
  );

  const loop = (): void => {
    renderer.draw([world], { owner: 0 });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void main();
