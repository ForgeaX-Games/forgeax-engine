// apps/hello/asi-world - ASI World scene + WASD-walking player demo
// migrated onto the tilemap object-layer path (feat-20260608 M4 / m4-t2).
//
// The legacy per-object sprite-entity path (one MaterialAsset per
// atlas tile + one MeshFilter/MeshRenderer/Layer/Transform entity per
// object) is **deleted**. Object decoration is now a single TileLayer
// with 153 asi_world object-atlas entries carrying widthCells /
// heightCells / pivotX / pivotY / collider via the TilesetTileEntry
// surface (requirements section MUST-1 / SHOULD-3 / NICE-4; AC-15
// grep-zero-hit on the three retired helpers).
//
// Coordinate convention
// ---------------------
// asi_world is top-down, y increases DOWN the map. forgeax is y-up.
// When we move data into TileLayer or object positions we flip
// `worldY = (rows - 1) - asi_y`. The `passable` array, the player
// position, the camera target, the input direction — everything in
// this file lives in the FLIPPED (y-up) coordinate space.
//
// Shared tilemap entity (plan-strategy §M4 preferred path "reuse terrain
// tilemap"): one Tilemap parent + N terrain TileLayer (one per height
// bucket) + 1 object TileLayer with layerOrder above terrain so the
// per-cell sprite quads paint over the floor. The combined TilesetAsset
// carries both atlases via `atlases: readonly Handle<TextureAsset>[]`
// and routes per-region through `regions[i].atlasIndex` (NICE-4).

import type { App, AppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  ChildOf,
  EngineEnvironmentError,
  HANDLE_QUAD,
  Layer,
  MeshFilter,
  MeshRenderer,
  setTransparentSortConfig,
  SpriteRegionOverride,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  Tilemap,
  TileLayer,
  Transform,
  encodeTileBits,
} from '@forgeax/engine-runtime';

import type {
  Handle,
  MaterialAsset,
  SamplerAsset,
  TextureAsset,
  TilesetAsset,
  TilesetRegion,
  TilesetTileCollider,
  TilesetTileEntry,
} from '@forgeax/engine-types';

import { fetchPngAsRgba } from './png-loader';
import type {
  ObjectTypeConfigFile,
  TerrainConfigFile,
  TerrainFile,
  TsjCollider,
  TsjFile,
} from './types';
import { buildWorld, pickFloorSpawnCell, type BuiltWorld } from './world-build';

const WORLD = '/world';
const CHARACTER = '/character';

// Sprite Layer.value above any encoded tilemap Layer.value range. The
// tilemap chunk-extract system encodes `Layer.value = (layerOrder << 20)
// | chunkIndex`; even with object layerOrder = 1000 that stays well
// under 2^31. Picking 1e8 leaves a comfortable margin.
const SPRITE_LAYER_VALUE = 100_000_000;

const PLAYER_SPEED = 6;

// Object TileLayer paints on top of terrain (layerOrder=0 default). Use
// a high value so the per-cell object quads sort above every terrain
// chunk in the per-entity TransparentEntry queue.
const OBJECT_LAYER_ORDER = 1000;

// Tile id encoding (engine reads `tileset.tiles[tileLayerCellValue - 1]`):
//   terrain TileLayer cell N -> tiles[N - 1]   (terrain block of tiles[])
//   object  TileLayer cell N -> tiles[N - 1]   (object  block of tiles[])
// We pack terrain then objects into one tiles[]; OBJECT_TILE_OFFSET
// shifts the object id range. See `composeTilesetAsset` for the layout.

const SHEET_COLS = 4;
const SHEET_ROWS = 4;
const FRAME_DURATION_MS_MOVE = 100;

type Direction = 'down' | 'left' | 'right' | 'up';
const DIR_ROW: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[asi-world] missing <canvas id="app"> in index.html');
}
const hud = document.querySelector<HTMLElement>('#hud');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[asi-world] no usable WebGPU backend:', err);
  } else {
    console.error('[asi-world] bootstrap error:', err);
  }
  if (hud) {
    hud.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  setHud('booting...');

  const appRes = await createApp(
    target,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app: App = appRes.value;
  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[asi-world] renderer.ready failed:', ready.error.code, ready.error.hint);
    setHud(`renderer.ready failed: ${ready.error.code}`);
    return;
  }
  const assets = app.renderer.assets;
  if (assets === null) {
    setHud('AssetRegistry null');
    return;
  }

  const world = app.world;

  const sortRes = setTransparentSortConfig(world, {
    mode: TRANSPARENT_SORT_MODE_LAYER_Y,
    yzAlpha: 1,
  });
  if (!sortRes.ok) {
    console.error('[asi-world] setTransparentSortConfig:', sortRes.error.code);
    return;
  }

  setHud('loading world data...');
  const [terrain, terrainConfig, terrainTsj, objectTsj, objectTypes] = await Promise.all([
    fetchJson<TerrainFile>(`${WORLD}/terrain.json`),
    fetchJson<TerrainConfigFile>(`${WORLD}/terrain-config.json`),
    fetchJson<TsjFile>(`${WORLD}/terrain_atlas.tsj`),
    fetchJson<TsjFile>(`${WORLD}/object_atlas.tsj`),
    fetchJson<ObjectTypeConfigFile>(`${WORLD}/object-type-config.json`),
  ]);

  const built = buildWorld({
    terrain,
    terrainConfig,
    terrainTsj,
    objectTsj,
    objectTypes,
  });

  setHud('decoding atlases...');
  const [terrainPng, objectPng, idlePng, movePng] = await Promise.all([
    fetchPngAsRgba(`${WORLD}/terrain_atlas.png`),
    fetchPngAsRgba(`${WORLD}/object_atlas.png`),
    fetchPngAsRgba(`${CHARACTER}/idle.png`),
    fetchPngAsRgba(`${CHARACTER}/move.png`),
  ]);

  const terrainAtlas = registerTexture(world, terrainPng);
  const objectAtlas = registerTexture(world, objectPng);
  const idleTex = registerTexture(world, idlePng);
  const moveTex = registerTexture(world, movePng);

  const sampler = world.allocSharedRef<'SamplerAsset', SamplerAsset>('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // Combined TilesetAsset: terrain entries first, then object entries.
  // OBJECT_TILE_OFFSET = terrain length so TileLayer.tiles can encode
  // object id N as (OBJECT_TILE_OFFSET + N + 1), which engine resolves
  // via `tileset.tiles[(value) - 1] = tileset.tiles[OBJECT_TILE_OFFSET + N]`.
  const combined = composeTilesetAsset({
    terrain: { atlas: terrainAtlas, atlasPng: terrainPng, tsj: terrainTsj },
    object: { atlas: objectAtlas, atlasPng: objectPng, tsj: objectTsj },
  });
  const objectTileOffset = terrainTsj.tiles.length;
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>(
    'TilesetAsset',
    combined,
  );

  const playerIdleMaterial = registerCharacterMaterial({ world, texture: idleTex, sampler });
  const playerMoveMaterial = registerCharacterMaterial({ world, texture: moveTex, sampler });

  setHud('spawning scene...');

  // Player spawn cell (centre-out floor search). Camera centres here so
  // the user sees the world from frame 0 — without it the camera would
  // sit at world (0, 0), far outside the 55x56 map.
  const spawnCell = pickFloorSpawnCell(built);
  const playerSpawnX = spawnCell.cellX + 0.5;
  const playerSpawnY = built.rows - 1 - spawnCell.cellY + 0.0;

  const aspect = target.width / Math.max(target.height, 1);
  const camHalfH = 12;
  const camHalfW = camHalfH * aspect;
  const cameraSpawn = world.spawn(
    {
      component: Transform,
      data: {
        posX: playerSpawnX,
        posY: playerSpawnY,
        posZ: 5,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect,
        near: 0.1,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -camHalfW,
        right: camHalfW,
        bottom: -camHalfH,
        top: camHalfH,
        clearR: 0.05,
        clearG: 0.05,
        clearB: 0.08,
        clearA: 1,
      },
    },
  );
  if (!cameraSpawn.ok) return logErr('camera spawn', cameraSpawn.error);
  const cameraEntity = cameraSpawn.value;

  // Shared Tilemap parent for terrain + object layers (plan-strategy
  // §M4 "reuse terrain tilemap": one chunk grid, one tileset handle).
  const tilemapSpawn = world.spawn(
    {
      component: Transform,
      data: { posX: 0, posY: 0, posZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    },
    {
      component: Tilemap,
      data: {
        cols: built.cols,
        rows: built.rows,
        tileSizeX: 1,
        tileSizeY: 1,
        tileset: tilesetHandle,
      },
    },
  );
  if (!tilemapSpawn.ok) return logErr('tilemap spawn', tilemapSpawn.error);
  const tilemapEntity = tilemapSpawn.value;

  // Terrain TileLayers — one per height bucket. Tile id encoding picks
  // the terrain section of tiles[] (object offset = 0).
  for (const layer of built.layers) {
    const flipped = buildTerrainTileLayer(built, layer.tiles);
    const r = world.spawn(
      { component: TileLayer, data: { tiles: flipped, layerOrder: layer.layerOrder } },
      { component: ChildOf, data: { parent: tilemapEntity } },
    );
    if (!r.ok) return logErr(`terrain TileLayer (height=${layer.heightKey})`, r.error);
  }

  // Object TileLayer — single anchor-cell sheet. 779 objects in the
  // asi_world test2-b30f5a scene; each gets one non-zero cell here and
  // the chunk-extract system spawns one per-cell entity carrying the
  // tile entry's widthCells / heightCells / pivot.
  const objectTiles = buildObjectTileLayer(built, objectTileOffset);
  const objectLayerSpawn = world.spawn(
    {
      component: TileLayer,
      data: { tiles: objectTiles, layerOrder: OBJECT_LAYER_ORDER },
    },
    { component: ChildOf, data: { parent: tilemapEntity } },
  );
  if (!objectLayerSpawn.ok) return logErr('object TileLayer', objectLayerSpawn.error);

  // Player: per-entity sprite riding the same TransparentEntry queue
  // as the tilemap-spawned per-cell entities (charter P4 consistent
  // abstraction). Y-sort lets the player walk behind / in front of
  // tall objects automatically (foot anchor at pivot.y).
  const playerSpawnRes = world.spawn(
    {
      component: Transform,
      data: {
        posX: playerSpawnX,
        posY: playerSpawnY,
        posZ: 0.1,
        scaleX: 2.5,
        scaleY: 4.0,
        scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [playerIdleMaterial] } },
    { component: Layer, data: { value: SPRITE_LAYER_VALUE } },
    {
      component: SpriteRegionOverride,
      data: { region: new Float32Array(regionForFrame(DIR_ROW.down, 0)) },
    },
  );
  if (!playerSpawnRes.ok) return logErr('player spawn', playerSpawnRes.error);
  const playerEntity = playerSpawnRes.value;

  // Movement + animation system. SpriteAnimation's `regions[]` cycling
  // doesn't fit a 4-direction sheet without rewriting on every input,
  // so we track direction + frame in closure state and write
  // SpriteRegionOverride.region directly each tick.
  let lastFacing: Direction = 'down';
  let lastIsMoving = false;
  let frameAccum = 0;
  let frameIndex = 0;
  world.addSystem({
    name: 'asi-world-player-move',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;
      const dt = readDeltaSeconds(world);

      let dx = 0;
      let dy = 0;
      if (snap.keyboard.down('w') || snap.keyboard.down('ArrowUp')) dy += 1;
      if (snap.keyboard.down('s') || snap.keyboard.down('ArrowDown')) dy -= 1;
      if (snap.keyboard.down('a') || snap.keyboard.down('ArrowLeft')) dx -= 1;
      if (snap.keyboard.down('d') || snap.keyboard.down('ArrowRight')) dx += 1;
      const moving = dx !== 0 || dy !== 0;
      if (moving) {
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        if (Math.abs(dx) >= Math.abs(dy)) lastFacing = dx > 0 ? 'right' : 'left';
        else lastFacing = dy > 0 ? 'up' : 'down';
      }

      const tr = world.get(playerEntity, Transform);
      if (!tr.ok) return;
      const cur = tr.value as { posX: number; posY: number };
      let nextX = cur.posX + dx * PLAYER_SPEED * dt;
      let nextY = cur.posY + dy * PLAYER_SPEED * dt;

      if (!isPassableAt(built, nextX, cur.posY)) nextX = cur.posX;
      if (!isPassableAt(built, nextX, nextY)) nextY = cur.posY;

      world.set(playerEntity, Transform, { posX: nextX, posY: nextY });

      if (moving) {
        const frameDur = FRAME_DURATION_MS_MOVE / 1000;
        frameAccum += dt;
        while (frameAccum >= frameDur) {
          frameAccum -= frameDur;
          frameIndex = (frameIndex + 1) & 0x3;
        }
      } else {
        frameAccum = 0;
        frameIndex = 0;
      }
      const region = regionForFrame(DIR_ROW[lastFacing], frameIndex);
      world.set(playerEntity, SpriteRegionOverride, {
        region: new Float32Array(region),
      });

      if (moving !== lastIsMoving) {
        lastIsMoving = moving;
        world.set(playerEntity, MeshRenderer, {
          materials: [moving ? playerMoveMaterial : playerIdleMaterial],
        });
      }

      world.set(cameraEntity, Transform, { posX: nextX, posY: nextY });

      const tileX = Math.floor(nextX);
      const tileY = built.rows - 1 - Math.floor(nextY);
      setHud(
        `cell (${tileX}, ${tileY})  facing=${lastFacing}  ` +
          `moving=${moving ? 'yes' : 'no'}\n` +
          `WASD / Arrow keys move`,
      );
    },
  });

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[asi-world] running. backend=${app.renderer.backend} ` +
      `world=${built.cols}x${built.rows} layers=${built.layers.length} objects=${built.objects.length}`,
  );
}

// ---------- helpers ---------------------------------------------------------

function setHud(text: string): void {
  if (hud) hud.textContent = text;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[asi-world] ${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

function logErr(label: string, err: { code?: string; hint?: string; message?: string }): void {
  console.error(`[asi-world] ${label} failed:`, err.code ?? err.message ?? err);
  setHud(`${label} failed: ${err.code ?? err.message ?? 'see console'}`);
}

function reportAppError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[asi-world] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[asi-world] ${err.code}: ${err.hint}`);
}

function registerTexture(
  world: World,
  png: { width: number; height: number; rgba: Uint8Array },
): Handle<'TextureAsset', 'shared'> {
  return world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', {
    kind: 'texture',
    width: png.width,
    height: png.height,
    format: 'rgba8unorm-srgb',
    data: png.rgba,
    colorSpace: 'srgb',
    mipmap: false,
    mipLevelCount: 1,
  });
}

interface ComposeTilesetArgs {
  readonly terrain: {
    readonly atlas: Handle<'TextureAsset', 'shared'>;
    readonly atlasPng: { readonly width: number; readonly height: number };
    readonly tsj: TsjFile;
  };
  readonly object: {
    readonly atlas: Handle<'TextureAsset', 'shared'>;
    readonly atlasPng: { readonly width: number; readonly height: number };
    readonly tsj: TsjFile;
  };
}

// Compose one TilesetAsset that carries both atlases via `atlases[]` +
// per-region `atlasIndex` (NICE-4 multi-atlas path). Terrain entries
// occupy the low half of tiles[]; object entries occupy the high half.
// Engine resolves a TileLayer cell value N via `tiles[N - 1]`, then
// `regions[entry.regionIndex].atlasIndex ?? 0` picks the atlas.
function composeTilesetAsset(args: ComposeTilesetArgs): TilesetAsset {
  const numTerrain = args.terrain.tsj.tiles.length;
  const regions: TilesetRegion[] = [];
  const tiles: TilesetTileEntry[] = [];

  // Terrain: unit-cell 16x16 regions, no pivot / no collider / atlasIndex
  // omitted (defaults to 0 → terrain atlas).
  for (const t of args.terrain.tsj.tiles) {
    regions.push({ x: t.x, y: t.y, width: t.width, height: t.height });
    tiles.push({ regionIndex: regions.length - 1 });
  }

  // Object: variable-size multi-cell regions, with widthCells /
  // heightCells / pivot derived from the .tsj. asi_world's `.tsj`
  // pivot is bottom-origin in [0, 1] (same as engine convention);
  // size in pixels divides by 16 px-per-cell.
  for (const t of args.object.tsj.tiles) {
    regions.push({
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      atlasIndex: 1,
    });
    tiles.push({
      regionIndex: regions.length - 1,
      widthCells: Math.max(1, Math.round(t.width / 16)),
      heightCells: Math.max(1, Math.round(t.height / 16)),
      pivotX: clamp01(t.pivot.x),
      pivotY: clamp01(t.pivot.y),
      collider: toEngineCollider(t.collider),
    });
  }

  return {
    kind: 'tileset',
    guid: `asi-world-tileset-${numTerrain}-${args.object.tsj.tiles.length}`,
    atlases: [args.terrain.atlas, args.object.atlas],
    tileWidth: 16,
    tileHeight: 16,
    columns: Math.max(args.terrain.atlasPng.width, args.object.atlasPng.width),
    rows: Math.max(args.terrain.atlasPng.height, args.object.atlasPng.height),
    regions,
    tiles,
  };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// asi_world `.tsj` collider 3-variant -> engine TilesetTileCollider
// 3-variant. Rect points that overflow [0, 1] are clipped to fit so
// register-time validation (validateTilesetPayload) accepts the
// payload (the source `.tsj` carries a small handful of rects with
// `x + w > 1` from authoring quirks; clamping is a data-ingest fix,
// not a workaround for an engine bug).
function toEngineCollider(c: TsjCollider): TilesetTileCollider {
  switch (c.type) {
    case 'none':
      return { type: 'none' };
    case 'rect': {
      const x = clamp01(c.rect[0]);
      const y = clamp01(c.rect[1]);
      const w = Math.max(0.001, Math.min(1 - x, c.rect[2]));
      const h = Math.max(0.001, Math.min(1 - y, c.rect[3]));
      return { type: 'rect', rect: [x, y, w, h] };
    }
    case 'polygon': {
      const points = c.points.map((p) => [clamp01(p[0]), clamp01(p[1])] as const);
      return { type: 'polygon', points };
    }
  }
}

interface RegisterCharacterMaterialArgs {
  readonly world: World;
  readonly texture: Handle<'TextureAsset', 'shared'>;
  readonly sampler: Handle<'SamplerAsset', 'shared'>;
}

function registerCharacterMaterial(
  args: RegisterCharacterMaterialArgs,
): Handle<'MaterialAsset', 'shared'> {
  return args.world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    paramValues: {
      baseColor: [1, 1, 1, 1],
      texture: args.texture,
      sampler: args.sampler,
      region: [0, 0, 1, 1],
      pivot: [0.5, 0.0],
    },
  });
}

function regionForFrame(row: number, frame: number): [number, number, number, number] {
  return [frame / SHEET_COLS, row / SHEET_ROWS, 1 / SHEET_COLS, 1 / SHEET_ROWS];
}

// Terrain TileLayer: 1 cell -> 1 atlas tile. asi_world stores
// graphic_index per cell (top-down y), we y-flip into engine space.
// TileLayer cell value = graphic_index + 1 (engine reads tiles[N-1]).
function buildTerrainTileLayer(built: BuiltWorld, layerTiles: Uint32Array): Uint32Array {
  const flipped = new Uint32Array(built.cols * built.rows);
  for (let y = 0; y < built.rows; y++) {
    const srcRow = y * built.cols;
    const dstRow = (built.rows - 1 - y) * built.cols;
    for (let x = 0; x < built.cols; x++) {
      const v = layerTiles[srcRow + x] ?? 0;
      if (v === 0) continue;
      // layerTiles already carries `idx + 1`; preserve sentinel.
      flipped[dstRow + x] = encodeTileBits(v, false, false, false, false);
    }
  }
  return flipped;
}

// Object TileLayer: anchor cell only. asi_world places each object at
// its (cellX, cellY) foot anchor; the tilemap chunk-extract system
// derives the multi-cell footprint from TilesetTileEntry.{widthCells,
// heightCells, pivotX, pivotY}. Tile id encoding shifts by the
// object-tile offset so engine resolves tiles[offset + asi_id].
function buildObjectTileLayer(built: BuiltWorld, objectTileOffset: number): Uint32Array {
  const tiles = new Uint32Array(built.cols * built.rows);
  for (const obj of built.objects) {
    const cellX = obj.cellX;
    const cellY = built.rows - 1 - obj.cellY;
    if (cellX < 0 || cellX >= built.cols || cellY < 0 || cellY >= built.rows) continue;
    // engine reads tiles[(value) - 1] = tiles[objectTileOffset + asi_id]
    const value = objectTileOffset + obj.tile.id + 1;
    tiles[cellY * built.cols + cellX] = encodeTileBits(value, false, false, false, false);
  }
  return tiles;
}

function isPassableAt(built: BuiltWorld, worldX: number, worldY: number): boolean {
  const cellX = Math.floor(worldX);
  const cellY = Math.floor(worldY);
  const asiY = built.rows - 1 - cellY;
  if (cellX < 0 || cellX >= built.cols || asiY < 0 || asiY >= built.rows) return false;
  return built.passable[asiY * built.cols + cellX] === 1;
}

function readDeltaSeconds(world: App['world']): number {
  const t = world.getResource<{ dt: number }>('Time');
  const dt = t?.dt ?? 1 / 60;
  return Math.min(dt, 0.05);
}
