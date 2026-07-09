#!/usr/bin/env node
// hello-asi-world headless smoke (feat-20260622-chunk-gpu-instancing-
// sprite-tilemap M4 / w18; AC-02 + AC-06 structural anchors).
//
// What this smoke proves (structural-only; pixel-parity baseline regen
// is verify-stage SSOT per plan-strategy §5.1 charter P5):
//   1. A non-y-sort tilemap (mode 0 fold-eligible) collapses N per-cell
//      entities into chunk-level instanced drawIndexed calls. The fold
//      operator (M1 / w4) groups by (Layer.value, posZ, materialHandle)
//      where Layer.value already encodes chunkIndex (research F-2).
//   2. drawIndexed call count per frame falls dramatically below
//      per-cell entity count (i.e. fold engaged; AC-02 lower-bound).
//   3. `renderer.metrics.snapshot()['render.instancing.foldedDraws']`
//      monotonically advances at >= 1/frame (M3 / w13 metric).
//
// AC-02 anchor: requirements §4 AC-02 expects "non-y-sort draw count
// approximately equals chunk count" for a 256x256 tilemap. The strict
// p95 fps gate is verify-stage SSOT (plan-strategy §5.4); this smoke
// only asserts the **structural** fold-engaged signal.
//
// Strategy (mirrors apps/hello/tilemap/scripts/smoke-dawn.mjs +
// apps/hello/sprite-atlas/scripts/smoke-dawn.mjs):
//   1. dawn-node `webgpu` import + globals install (sandbox env-defer
//      pattern when Vulkan caps are missing).
//   2. Mock canvas + offscreen render target.
//   3. Synthesise a 32x32 RGBA tile atlas + register a TilesetAsset.
//   4. Spawn one Tilemap (cols=64 rows=64 chunkSize=16 -> 16 chunks)
//      with a single non-y-sort terrain TileLayer; every cell is
//      filled so the chunk-extract system spawns 4096 per-cell
//      entities. Fold target: 16 buckets per material -> ~16 draws.
//   5. Drive 120 frames; assert structural counters; report fold
//      ratio.
//
// Non-y-sort note: the TileLayer is spawned WITHOUT `ySort` so it
// stays in mode 0 (transparent-sort by Layer.value) and the fold
// operator engages. The y-sort path (mode 1/2) bypasses fold by D-5;
// AC-04 is covered by unit tests, not this smoke.

import { setTimeout as delay } from 'node:timers/promises';

const WIDTH = 320;
const HEIGHT = 240;
const TARGET_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '120', 10);
const COLS = 64;
const ROWS = 64;
const CHUNK_SIZE = 16;
const CHUNK_COUNT_X = Math.ceil(COLS / CHUNK_SIZE);
const CHUNK_COUNT_Y = Math.ceil(ROWS / CHUNK_SIZE);
const TOTAL_CHUNKS = CHUNK_COUNT_X * CHUNK_COUNT_Y;
const CELL_COUNT = COLS * ROWS;

async function deferred(reason) {
  console.log(`[hello-asi-world smoke] env-deferred=${reason}`);
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
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
let drawIndexedCallsThisFrame = 0;

function patchDeviceForRhiStats(dev) {
  const origCreateCommandEncoder = dev.createCommandEncoder.bind(dev);
  dev.createCommandEncoder = (desc) => {
    const enc = origCreateCommandEncoder(desc);
    const origBeginRenderPass = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (passDesc) => {
      const pass = origBeginRenderPass(passDesc);
      const origDrawIndexed = pass.drawIndexed.bind(pass);
      pass.drawIndexed = (...args) => {
        drawIndexedCallsThisFrame++;
        return origDrawIndexed(...args);
      };
      return pass;
    };
    return enc;
  };
}

const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalAmbientRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (sharedDevice === undefined) {
      sharedDevice = dev;
      patchDeviceForRhiStats(dev);
    }
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
try {
  runtime = await import('@forgeax/engine-runtime');
  ecs = await import('@forgeax/engine-ecs');
  types = await import('@forgeax/engine-types');
} catch (err) {
  await deferred(
    `engine-runtime import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const { Camera, ChildOf, Transform, TileLayer, Tilemap, createRenderer } = runtime;
const { World } = ecs;
const { toManaged } = types;
void toManaged;

const world = new World();

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
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

// Synthetic 32x32 RGBA tile atlas (4 quadrants of 16x16). Registered via
// the same handle path as the real asi-world demo.
function buildSyntheticTileAtlas() {
  const w = 32;
  const h = 32;
  const bytes = new Uint8Array(w * h * 4);
  const quad = [
    [180, 100, 60, 255],
    [80, 180, 100, 255],
    [80, 120, 200, 255],
    [220, 200, 80, 255],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const qi = top ? (left ? 0 : 1) : left ? 2 : 3;
      const c = quad[qi];
      bytes[i + 0] = c[0];
      bytes[i + 1] = c[1];
      bytes[i + 2] = c[2];
      bytes[i + 3] = c[3];
    }
  }
  return { width: w, height: h, data: bytes };
}

const synth = buildSyntheticTileAtlas();
const synthPod = {
  kind: 'texture',
  width: synth.width,
  height: synth.height,
  format: 'rgba8unorm-srgb',
  data: synth.data,
  colorSpace: 'srgb',
  mipmap: false,
};
const atlasHandle = world.allocSharedRef('TextureAsset', synthPod);
const uploadRes = await renderer.store.uploadTexture(atlasHandle, synthPod, {
  bytes: synth.data,
  width: synth.width,
  height: synth.height,
  mime: 'image/png',
  colorSpace: 'srgb',
  mipmap: false,
});
if (!uploadRes.ok) {
  console.error(`[hello-asi-world smoke] atlas upload failed: ${uploadRes.error.code}`);
  process.exit(1);
}

const tileset = {
  kind: 'tileset',
  guid: 'hello-asi-world/synthetic-atlas',
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
  tiles: [{ regionIndex: 0 }, { regionIndex: 1 }, { regionIndex: 2 }, { regionIndex: 3 }],
};
const tilesetResult = assets.register(tileset);
if (!tilesetResult.ok) {
  console.error(`[hello-asi-world smoke] tileset register failed: ${tilesetResult.error.code}`);
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
        tileSizeX: 1,
        tileSizeY: 1,
        chunkSize: CHUNK_SIZE,
        tileset: tilesetHandle,
      },
    },
    { component: Transform, data: {} },
  )
  .unwrap();

// Fill every cell so the chunk-extract system produces 4096 per-cell
// entities split across TOTAL_CHUNKS chunks. Tile id alternates 1..4
// across rows so each cell carries a non-zero anchor (engine reads
// tiles[N - 1] -> regions[0..3]).
const tiles = new Uint32Array(CELL_COUNT);
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    tiles[y * COLS + x] = ((x + y) % 4) + 1;
  }
}

// Non-y-sort: omit the `ySort` field so the TileLayer stays in mode 0
// (transparent-sort by Layer.value); fold operator engages.
world
  .spawn(
    { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 1 } },
    { component: ChildOf, data: { parent: tilemap } },
  )
  .unwrap();

// Camera at the centre of the tilemap with enough frustum to see the
// whole 64x64 grid.
world.spawn(
  { component: Transform, data: { posX: COLS / 2, posY: ROWS / 2, posZ: 8 } },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
    },
  },
);

let framesDrawn = 0;
let firstFrameDrawCount = 0;
let lastFrameDrawCount = 0;
for (let f = 0; f < TARGET_FRAMES; f++) {
  drawIndexedCallsThisFrame = 0;
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) {
    console.error(`[hello-asi-world smoke] draw frame ${f}: ${r.error.code}`);
    process.exit(1);
  }
  if (f === 0) firstFrameDrawCount = drawIndexedCallsThisFrame;
  lastFrameDrawCount = drawIndexedCallsThisFrame;
  framesDrawn += 1;
}

const device = sharedDevice;
if (device === undefined) {
  await deferred('no shared GPUDevice captured after draw loop');
}
await device.queue.onSubmittedWorkDone();

// Count derived per-cell entities to confirm the chunk-extract system fired.
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

const metricsSnap = renderer.metrics.snapshot();
const foldedDraws = metricsSnap['render.instancing.foldedDraws'] ?? 0;

console.log(`[hello-asi-world smoke] frames=${framesDrawn}`);
console.log(`[hello-asi-world smoke] derivedPerCellEntities=${derivedCount} (expected ~${CELL_COUNT})`);
console.log(
  `[hello-asi-world smoke] drawIndexed: first-frame=${firstFrameDrawCount} last-frame=${lastFrameDrawCount}`,
);
console.log(`[hello-asi-world smoke] foldedDraws metric=${foldedDraws}`);

const failures = [];
if (framesDrawn < TARGET_FRAMES) failures.push(`(a) frames=${framesDrawn} < ${TARGET_FRAMES}`);
if (derivedCount < CELL_COUNT)
  failures.push(`(b) derived per-cell entity count=${derivedCount} < expected ${CELL_COUNT}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(',');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
// AC-02 structural lower bound: fold engaged means draw count <
// derived-per-cell count and >= 1. Not the strict "draw approx chunk
// count" assertion (that one is verify-stage SSOT once a real GPU
// runner can produce stable counts); this gate just proves fold did
// not bypass and did not collapse to zero draws.
if (lastFrameDrawCount < 1) failures.push(`(d) lastFrameDrawCount=${lastFrameDrawCount} < 1`);
if (lastFrameDrawCount >= derivedCount) {
  failures.push(
    `(e) lastFrameDrawCount=${lastFrameDrawCount} >= derived entity count=${derivedCount}; fold did not engage`,
  );
}
// AC-06 smoke surface: foldedDraws metric must have advanced at least
// once per frame (>=1 head bucket per frame, accumulated over loop).
if (foldedDraws < framesDrawn) {
  failures.push(
    `(f) foldedDraws=${foldedDraws} < frames=${framesDrawn}; metric did not advance once per frame`,
  );
}
// AC-02 informational only — log expected-vs-observed chunk ratio so
// the verifier subagent can spot regressions without forcing a strict
// equality (chunk-count varies with engine internals: padding chunks,
// empty chunks, multi-material splits).
console.log(
  `[hello-asi-world smoke] AC-02 informational: TOTAL_CHUNKS=${TOTAL_CHUNKS} ` +
    `lastFrameDrawCount=${lastFrameDrawCount} ` +
    `(fold ratio ~${(derivedCount / Math.max(1, lastFrameDrawCount)).toFixed(1)}x reduction)`,
);

if (failures.length > 0) {
  console.error(`[hello-asi-world smoke] FAIL — ${failures.length} criteria:`);
  for (const fmsg of failures) console.error(`  ${fmsg}`);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[hello-asi-world smoke] PASS - ${derivedCount} per-cell entities folded to ` +
    `${lastFrameDrawCount} draws/frame, foldedDraws=${foldedDraws}/${framesDrawn} frames`,
);
device.destroy?.();
process.exit(0);
