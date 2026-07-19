// hello-tilemap demo entry (feat-20260608 M0 baseline rebuild).
//
// Browser entry — the dawn-node smoke harness drives an equivalent flow
// via scripts/smoke-dawn.mjs (charter P5 producer/consumer split: the
// dev/preview path runs in a real WebGPU browser; the smoke gate runs in
// node-dawn).
//
// Scenario:
//   - Synthesise a 32x32 RGBA atlas inline (charter P5 — no forgeax-engine-assets
//     submodule dependency in the M0 baseline; m4 demos may switch to
//     submodule-backed atlases).
//   - Register a TilesetAsset with 4 regions + 4 tile entries.
//   - Spawn a Tilemap (cols=8 rows=8 chunkSize=4) + a single TileLayer with
//     a hand-chosen anchor table; tilemapChunkExtractSystem will derive one
//     ECS entity per non-zero cell once renderer.draw is called.
//   - Pre-Renderer.ready, register an unmanaged TextureAsset handle into the
//     AssetRegistry so the atlas handle in the Tileset points at a real
//     uploaded GPU texture (charter P3 — the M0 baseline cannot rely on a
//     dangling texture handle).
//
// AC-14 hook: the dirty-rebuild contract surfaces on frame 59 -> 60 via
// the scripts/smoke-dawn.mjs harness (this browser entry just exercises
// the rebuild path so dev tooling can see it).

import { World } from '@forgeax/engine-ecs';
import { toShared, type TilesetAsset } from '@forgeax/engine-types';
import {
  Camera,
  ChildOf,
  Transform,
  TileLayer,
  Tilemap,
  createRenderer,
  markTileLayerDirty,
} from '@forgeax/engine-runtime';

async function main(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null;
  if (canvas === null) return;
  const renderer = await createRenderer(canvas, {});
  const ready = await renderer.ready;
  if (!ready.ok) {
    // eslint-disable-next-line no-console
    console.error('[hello-tilemap] renderer.ready failed:', ready.error.code);
    return;
  }
  const world = new World();

  // Register a placeholder atlas TextureAsset (shared-mode handle id; the
  // M0 baseline does not exercise sampling — the smoke gate verifies only
  // the extract system + dirty rebuild path).
  const atlasHandle = toShared<'TextureAsset'>(101);

  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'hello-tilemap/atlas',
    atlases: [atlasHandle],
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: [
      { x: 0, y: 0, width: 16, height: 16 },
      { x: 16, y: 0, width: 16, height: 16 },
      { x: 0, y: 16, width: 16, height: 16 },
      { x: 16, y: 16, width: 16, height: 16 },
    ],
    tiles: [
      { regionIndex: 0 },
      { regionIndex: 1 },
      { regionIndex: 2 },
      { regionIndex: 3 },
    ],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
    'TilesetAsset',
    tileset,
  );

  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols: 8, rows: 8, tileSize: [1, 1], chunkSize: 4, tileset: tilesetHandle },
      },
      { component: Transform, data: {} },
    )
    .unwrap();

  const cols = 8;
  const rows = 8;
  const tiles = new Uint32Array(cols * rows);
  // anchor: every cell along the diagonal carries tile 1..4 cycle.
  for (let i = 0; i < Math.min(cols, rows); i++) {
    tiles[i * cols + i] = (i % 4) + 1;
  }
  const layer = world
    .spawn(
      { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 1 } },
      { component: ChildOf, data: { parent: tilemap } },
      { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1]} },
    )
    .unwrap();

  world.spawn(
    {
      component: Transform,
      data: { pos: [4, 4, 8]},
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: canvas.width / canvas.height, near: 0.1, far: 100 },
    },
  );

  // Drive the per-frame loop; rAF lives in the browser only.
  let frame = 0;
  const loop = (): void => {
    frame += 1;
    if (frame === 60) {
      // AC-14 dirty-rebuild contract — mutate the tiles in place and mark
      // the layer dirty so the next extract pass rebuilds derived entities.
      const view = world.get(layer, TileLayer).unwrap().tiles as Uint32Array;
      view[0] = 0;
      view[7 * cols + 7] = 1;
      markTileLayerDirty(world, layer).unwrap();
    }
    renderer.draw([world], { owner: 0 });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void main();
