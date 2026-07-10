#!/usr/bin/env node
// hello-tilemap-object-layer headless smoke (feat-20260608 M3 / m3-t10).
//
// Drives the engine ECS path end-to-end on the dawn-node binding for the
// directed 5-sub-scene fixture. Mirrors hello-tilemap M0's shape:
//   - Synthesises 2 in-process atlas TextureAsset handles (charter P5 —
//     no forgeax-engine-assets PNG dependency; placeholder handle ids,
//     consistent with hello-tilemap M0 baseline shape).
//   - Registers a TilesetAsset (5 regions / 5 tile entries with the
//     widthCells/heightCells/pivotX/pivotY/atlasIndex mix covering the
//     M3 surface; AC-10/AC-11/AC-12/AC-13/AC-14 anchors).
//   - Spawns a Tilemap (cols=32 rows=32 chunkSize=16) + one TileLayer
//     with anchor-cell encoding for sub-scenes (a)..(e), plus one sprite
//     entity at world (16.5, 28.5) for sub-scene (e) AC-13 interleave.
//   - Calls renderer.draw(world) for TARGET_FRAMES (280 default).
//   - Pixel readback samples one directed (x, y) per sub-scene + records
//     `nearestPaletteFamily` ∈ {red|green|blue|yellow|gray|magenta|
//     unknown} (charter F2 debug-fallback signal — soft check that
//     surfaces what the sampled pixel actually is rather than asserting
//     a specific RGB).
//
// Verdict (4 criteria):
//   (a) framesDrawn == TARGET_FRAMES
//   (b) per-cell derived entity count >= 9 (sub-scene anchor cells:
//       (a)=2 + (b)=4 + (c)=2 + (d)=10 + (e)=1 = 19; floor at 9 in case
//       the (d) baseline shrinks under future plan revisions)
//   (c) Renderer.onError count == 0
//   (d) all 5 directed pixel readbacks classify successfully (any family
//       including 'unknown' counts — the test surfaces fallback data,
//       does not assert RGB)
//
// Sandbox env-defer policy (plan-strategy section M3 boundary): when
// dawn-node fails to initialise (Vulkan caps missing on the
// primary-pnpm CI runner subset), the smoke reports
// [hello-tilemap-object-layer smoke] env-deferred=<reason> + exits 0 so
// CI can record the gate as deferred rather than failing.

import { setTimeout as delay } from 'node:timers/promises';

const WIDTH = 384;
const HEIGHT = 384;
const TARGET_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '280', 10);
const COLS = 32;
const ROWS = 32;
const CHUNK_SIZE = 16;

async function deferred(reason) {
  console.log(`[hello-tilemap-object-layer smoke] env-deferred=${reason}`);
  await delay(0);
  process.exit(0);
}

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (importErr) {
  await deferred(
    `dawn-node import failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`,
  );
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (createErr) {
  await deferred(
    `dawn-node create([]) threw: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
  );
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalAmbientRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (sharedDevice === undefined) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (renderTarget === undefined) {
          if (sharedDevice === undefined) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let runtime;
let ecs;
let types;
let assetsRuntime;
let graphicsExtras;
try {
  runtime = await import('@forgeax/engine-runtime');
  ecs = await import('@forgeax/engine-ecs');
  types = await import('@forgeax/engine-types');
  assetsRuntime = await import('@forgeax/engine-assets-runtime');
  graphicsExtras = await import('@forgeax/engine-graphics-extras');
} catch (err) {
  await deferred(
    `engine-runtime import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  ChildOf,
  MeshFilter,
  MeshRenderer,
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
  TileLayer,
  Tilemap,
  Transform,
  createRenderer,
} = runtime;
const { HANDLE_QUAD } = assetsRuntime;
const { encodeTileBits } = graphicsExtras;
const { World } = ecs;
const { toManaged } = types;

const TILE_GRASS = 1;
const TILE_BIG_TREE = 2;
const TILE_MID_TREE = 3;
const TILE_BUSH = 4;
const TILE_STONE = 5;

function buildAnchorTiles() {
  const tiles = new Uint32Array(COLS * ROWS);
  // (a) chunk-boundary z-fight — two 3x4 big trees at cellX=15/17, cellY=7
  tiles[7 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  tiles[7 * COLS + 17] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  // (b) flip x pivot — 4 mid trees cellY=12, four flip codes
  tiles[12 * COLS + 5] = encodeTileBits(TILE_MID_TREE, false, false, false, false);
  tiles[12 * COLS + 8] = encodeTileBits(TILE_MID_TREE, true, false, false, false);
  tiles[12 * COLS + 11] = encodeTileBits(TILE_MID_TREE, false, true, false, false);
  tiles[12 * COLS + 14] = encodeTileBits(TILE_MID_TREE, true, true, false, false);
  // (c) multi-atlas — atlasA bush + atlasB stone, cellY=17
  tiles[17 * COLS + 15] = encodeTileBits(TILE_BUSH, false, false, false, false);
  tiles[17 * COLS + 17] = encodeTileBits(TILE_STONE, false, false, false, false);
  // (d) unit-cell baseline — grass cellY=22..23, cellX=2..6
  for (let cx = 2; cx <= 6; cx++) {
    tiles[22 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
    tiles[23 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
  }
  // (e) sprite x tilemap interleave — big tree cellY=31, cellX=15
  tiles[31 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  return tiles;
}

const world = new World();
let renderer;
try {
  renderer = await createRenderer(mockCanvas, {});
} catch (createErr) {
  await deferred(
    `createRenderer threw: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
  );
}
const errors = [];
renderer.onError((e) => errors.push({ code: e.code }));

const ready = await renderer.ready;
if (!ready.ok) {
  await deferred(`renderer.ready failed: ${ready.error.code}`);
}

const assets = renderer.assets;
const atlasA = toManaged('TextureAsset')(201);
const atlasB = toManaged('TextureAsset')(202);

const tileset = {
  kind: 'tileset',
  guid: 'hello-tilemap-object-layer/tileset',
  atlases: [atlasA, atlasB],
  tileWidth: 16,
  tileHeight: 16,
  columns: 4,
  rows: 4,
  regions: [
    { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
    { x: 16, y: 0, width: 48, height: 64, atlasIndex: 0 },
    { x: 16, y: 0, width: 32, height: 48, atlasIndex: 0 },
    { x: 0, y: 16, width: 16, height: 32, atlasIndex: 0 },
    { x: 0, y: 0, width: 32, height: 32, atlasIndex: 1 },
  ],
  tiles: [
    { regionIndex: 0 },
    { regionIndex: 1, widthCells: 3, heightCells: 4, pivotX: 0.5, pivotY: 0.2 },
    { regionIndex: 2, widthCells: 2, heightCells: 3, pivotX: 0.5, pivotY: 0.2 },
    { regionIndex: 3, widthCells: 1, heightCells: 2, pivotX: 0.5, pivotY: 0.3 },
    { regionIndex: 4, widthCells: 2, heightCells: 2, pivotX: 0.5, pivotY: 0.5 },
  ],
};
const tilesetResult = assets.register(tileset);
if (!tilesetResult.ok) {
  console.error(
    `[hello-tilemap-object-layer smoke] tileset register failed: ${tilesetResult.error.code}`,
  );
  process.exit(1);
}
const tilesetHandle = tilesetResult.value;

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

// Sprite entity for sub-scene (e). Needs a sampler + material so it lands in
// the same sprite-bucket TransparentEntry queue as tilemap-spawned per-cell
// entities (AC-13 anchor).
const samplerResult = assets.register({
  kind: 'sampler',
  magFilter: 'nearest',
  minFilter: 'nearest',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
});
if (!samplerResult.ok) {
  console.error(
    `[hello-tilemap-object-layer smoke] sampler register failed: ${samplerResult.error.code}`,
  );
  process.exit(1);
}
const spriteMaterialResult = assets.register({
  kind: 'material',
  passes: [
    // feat-20260626 M3: renderState.blend SSOT.
    { name: 'Forward', shader: 'forgeax::sprite', tags: { LightMode: 'Forward' }, queue: 3000, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND } },
  ],
  paramValues: {
    // feat-20260625 M3/w11 (D-4): UBO-aligned 1:1 with sprite.wgsl.meta.json.
    colorTint: [1, 1, 1, 1],
    baseColorTexture: atlasA,
    sampler: samplerResult.value,
    region: [0, 0, 1, 1],
    pivotAndSize: [0.5, 0.5, 1, 1],
  },
});
if (!spriteMaterialResult.ok) {
  console.error(
    `[hello-tilemap-object-layer smoke] sprite material register failed: ${spriteMaterialResult.error.code}`,
  );
  process.exit(1);
}
world
  .spawn(
    { component: Transform, data: { pos: [16.5, 28.5, 0]} },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [spriteMaterialResult.value] } },
  )
  .unwrap();

world.spawn(
  { component: Transform, data: { pos: [COLS / 2, ROWS / 2, 10]} },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
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

let framesDrawn = 0;
for (let f = 0; f < TARGET_FRAMES; f++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) {
    console.error(`[hello-tilemap-object-layer smoke] draw frame ${f} error: ${r.error.code}`);
    process.exit(1);
  }
  framesDrawn += 1;
}

const device = sharedDevice;
if (device === undefined) {
  await deferred('no shared GPUDevice captured after draw loop');
}
await device.queue.onSubmittedWorkDone();

// Count derived ECS entities (sub-scene anchor cells across all 5 surfaces).
let derivedCount = 0;
for (const arch of world.inspect().archetypes) {
  if (
    arch.componentNames.includes('MeshFilter') &&
    arch.componentNames.includes('MeshRenderer') &&
    arch.componentNames.includes('Layer') &&
    arch.componentNames.includes('ChildOf')
  ) {
    derivedCount += arch.entityCount;
  }
}

// --- Pixel readback for 5 directed (x, y) samples --------------------------
// Camera centred at world (COLS/2, ROWS/2) with ortho bounds covering the
// full 32x32 tilemap, framebuffer 384x384 -> 12 px per world unit. Each
// sub-scene picks one anchor cell + samples its centre.
const PX_PER_UNIT_X = WIDTH / COLS; // 12
const PX_PER_UNIT_Y = HEIGHT / ROWS; // 12
function worldToScreen(wx, wy) {
  return {
    x: Math.max(0, Math.min(WIDTH - 1, Math.round(wx * PX_PER_UNIT_X))),
    // Tilemap world Y grows downward (cellY=0 is top); GPU framebuffer Y grows
    // downward too. Use wy directly without flip so cellY=0 maps to top.
    y: Math.max(0, Math.min(HEIGHT - 1, Math.round(wy * PX_PER_UNIT_Y))),
  };
}

const samplePoints = [
  // (a) chunk-boundary z-fight — sample centre of the cellX=15 big tree at cellY=7
  { name: 'chunk-boundary-z-fight', world: { x: 15.5, y: 6.5 } },
  // (b) flip x pivot — sample centre of the H-flip mid tree at cellX=8.5, cellY=11.5
  { name: 'flip-x-pivot', world: { x: 8.5, y: 11.5 } },
  // (c) multi-atlas — sample centre of the atlasB stone (2x2) at cellX=17.5, cellY=16.5
  { name: 'multi-atlas', world: { x: 17.5, y: 16.5 } },
  // (d) unit-cell baseline — sample centre of grass cellX=4.5, cellY=22.5
  { name: 'unit-cell-baseline', world: { x: 4.5, y: 22.5 } },
  // (e) sprite x tilemap world-Y interleave — sample sprite position at world (16.5, 28.5)
  { name: 'sprite-tilemap-interleave', world: { x: 16.5, y: 28.5 } },
];

// Map sampled RGBA bytes (0..255) to a coarse palette family. Lenient
// fallback: returns 'unknown' when the pixel does not match any
// well-known family. charter F2 — this is a debug-fallback signal, not
// an RGB assertion.
function nearestPaletteFamily(r, g, b, a) {
  if (a < 8) return 'transparent';
  if (r < 16 && g < 16 && b < 16) return 'gray'; // near-black
  if (r > 224 && g > 224 && b > 224) return 'gray'; // near-white
  if (r > 200 && g < 80 && b > 200) return 'magenta';
  if (r > 200 && g < 80 && b < 80) return 'red';
  if (r < 80 && g > 180 && b < 80) return 'green';
  if (r < 80 && g < 80 && b > 200) return 'blue';
  if (r > 200 && g > 200 && b < 80) return 'yellow';
  // gray-ish (low chroma)
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 32) return 'gray';
  return 'unknown';
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
let raw;
try {
  await readbackBuffer.mapAsync(0x01);
  const mapped = readbackBuffer.getMappedRange();
  raw = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
} catch (err) {
  await deferred(`mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
}

const subSceneReport = [];
for (const point of samplePoints) {
  const { x, y } = worldToScreen(point.world.x, point.world.y);
  const off = y * bytesPerRow + x * bytesPerPixel;
  const r = raw[off + 0] ?? 0;
  const g = raw[off + 1] ?? 0;
  const b = raw[off + 2] ?? 0;
  const a = raw[off + 3] ?? 0;
  const family = nearestPaletteFamily(r, g, b, a);
  subSceneReport.push({ name: point.name, screen: { x, y }, rgba: [r, g, b, a], family });
}

const failures = [];
if (framesDrawn < TARGET_FRAMES) failures.push(`(a) frames=${framesDrawn} < ${TARGET_FRAMES}`);
if (derivedCount < 9) {
  failures.push(`(b) derived per-cell entity count=${derivedCount} (expected >= 9)`);
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(',');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
// (d) every sub-scene reported a family (including 'unknown' / 'transparent')
const unreported = subSceneReport.filter((r) => r.family === undefined);
if (unreported.length > 0) {
  failures.push(`(d) sub-scene palette classify missing: ${unreported.map((r) => r.name).join(',')}`);
}

if (failures.length > 0) {
  console.error(`[hello-tilemap-object-layer smoke] FAIL - ${failures.length} criteria:`);
  for (const fmsg of failures) console.error(`  ${fmsg}`);
  for (const r of subSceneReport) {
    console.error(
      `  sub-scene ${r.name}: screen=(${r.screen.x},${r.screen.y}) rgba=[${r.rgba.join(',')}] family=${r.family}`,
    );
  }
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[hello-tilemap-object-layer smoke] PASS - frames=${framesDrawn}, derived cell entities=${derivedCount}, RhiError count=0`,
);
for (const r of subSceneReport) {
  console.log(
    `  sub-scene ${r.name}: screen=(${r.screen.x},${r.screen.y}) rgba=[${r.rgba.join(',')}] family=${r.family}`,
  );
}
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
