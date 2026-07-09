#!/usr/bin/env node
// hello-custom-importer headless smoke -- acceptance gate for
// feat-20260629-importer-self-declared-fold-contract (M5 / w15; AC-01 / AC-09).
//
// This smoke proves the WHOLE feat end-to-end through the REAL build pipeline
// (not a registerWithGuid in-memory stub):
//
//   1. `vite build` runs the host importer (reelGameBlobImporter, injected via
//      pluginPack({ importers })) at build time. The importer folds the host's
//      `.reel.json` blob into a DDC `.pack.json` + a pack-index.json row of
//      kind 'reel-game-blob' (P2 default passthrough -- no engine whitelist).
//   2. Structural assertion: the emitted dist/pack-index.json carries a row of
//      kind 'reel-game-blob' for the declared GUID (AC-01 structural).
//   3. dawn-node WebGPU + a `globalThis.fetch` that reads the built dist/
//      artefacts off disk -- the SAME production fetch chain the browser uses
//      (pack-index.json -> .pack.json), no HTTP server required.
//   4. Real load + real use (AC-01 functional): register the host loader on
//      renderer.assets, configurePackIndex, `loadByGuid<ReelGameBlob>`, assert
//      the typed payload (title + reels), then spawn one cube per reel and
//      render 300 frames + pixel readback (the scene is non-empty because the
//      blob really loaded).
//
// Verdict criteria:
//   (a) backend=webgpu
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) pack-index.json has a 'reel-game-blob' row for the declared GUID
//   (d) loadByGuid returned the typed blob (title + 3 reels) -- REAL load
//   (e) NDC-region pixel distance to black > eps -- REAL use (cubes rendered)
//   (f) Renderer.onError RhiError count == 0
//
// AC-07 (no Importer.fold) is enforced by a separate grep gate in the w15
// acceptanceCheck, not here.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-custom-importer] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 200;
const HEIGHT = 150;

const REEL_GAME_LEVEL_1_GUID = '8215d398-8120-4ffa-baf2-4496216cd4f6';
const REEL_GAME_BLOB_KIND = 'reel-game-blob';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const distDir = resolve(appRoot, 'dist');

// --- 0. vite build: run the host importer through the real pipeline ----------

console.log('[hello-custom-importer] vite build (runs host importer + emits pack-index.json)...');
try {
  execFileSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch (err) {
  console.error(
    `[smoke] FAIL - vite build failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-custom-importer smoke');
  process.exit(1);
}

const packIndexPath = resolve(distDir, 'pack-index.json');
if (!existsSync(packIndexPath)) {
  console.error(`[smoke] FAIL - dist/pack-index.json missing after build (${packIndexPath})`);
  process.exit(1);
}

// --- (c) structural: pack-index has a reel-game-blob row ---------------------

const packIndex = JSON.parse(readFileSync(packIndexPath, 'utf8'));
const reelRow = Array.isArray(packIndex)
  ? packIndex.find(
      (row) =>
        row?.guid?.toLowerCase() === REEL_GAME_LEVEL_1_GUID.toLowerCase() &&
        row?.kind === REEL_GAME_BLOB_KIND,
    )
  : undefined;
const structuralOk = reelRow !== undefined;
console.log(
  `[smoke] pack-index reel-game-blob row=${JSON.stringify(reelRow ?? null)}`,
);

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- fetch shim: serve the built dist/ artefacts off disk --------------------
// loadByGuidProd needs globalThis.fetch. dawn-node has no HTTP server, so we
// map the production fetch URLs (/pack-index.json + the .pack.json relativeUrl)
// onto the on-disk dist/ tree. This is the SAME chain a browser drives -- the
// importer ran at vite build time and the runtime never re-imports.
function resolveDistUrl(url) {
  // url is e.g. '/pack-index.json' or '/assets/<guid>-<hash>.pack.json'
  const clean = url.split('?')[0].split('#')[0];
  const rel = clean.startsWith('/') ? clean.slice(1) : clean;
  return resolve(distDir, rel);
}
const nativeFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const urlStr = typeof url === 'string' ? url : String(url);
  // data: URLs (e.g. the shader manifest encoded by the smoke) are handled by
  // the native fetch -- only the production pack-index / .pack.json URLs map
  // onto the on-disk dist/ tree.
  if (urlStr.startsWith('data:')) {
    if (nativeFetch) return nativeFetch(url, init);
    const comma = urlStr.indexOf(',');
    const body = decodeURIComponent(urlStr.slice(comma + 1));
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  }
  const filePath = resolveDistUrl(urlStr);
  if (!existsSync(filePath)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }
  const buf = readFileSync(filePath);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(buf.toString('utf8')),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

// capture the raw device for readback (mirrors hello-cube smoke)
let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ----------------------------

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
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Drive the engine + the host loader ----------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;

// The host loader, inlined here as a plain-JS twin of src/reel-game-blob-loader.ts
// (the browser entry main.ts imports the .ts; this node smoke harness cannot
// import a raw .ts module, so it mirrors the trivial passthrough loader -- same
// kind string, same passthrough behaviour). The src/ loader is what ships; this
// twin only exists so the node smoke drives the identical loadByGuid dispatch.
function reelGameBlobLoader() {
  return {
    kind: REEL_GAME_BLOB_KIND,
    load(payload) {
      return payload;
    },
  };
}

const MANIFEST_PATH = resolve(distDir, 'shaders', 'manifest.json');
if (!existsSync(MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing (${MANIFEST_PATH})`);
  process.exit(1);
}
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[hello-custom-importer] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const assets = renderer.assets;
if (assets === null || assets === undefined) {
  console.error('[smoke] FAIL - renderer.assets is null');
  process.exit(1);
}

// Step 3: register the host loader (runtime mirror of the build-time importer)
assets.loaders.register(reelGameBlobLoader());
assets.configurePackIndex('/pack-index.json');

// Step 4 (d): REAL load through the production fetch chain
const guidRes = AssetGuid.parse(REEL_GAME_LEVEL_1_GUID);
if (!guidRes.ok) {
  console.error(`[smoke] FAIL - GUID parse failed: ${guidRes.error.code}`);
  process.exit(1);
}
const loadRes = await assets.loadByGuid(guidRes.value);
let blob;
if (loadRes.ok) {
  blob = loadRes.value;
  console.log(
    `[hello-custom-importer] loaded reel-game blob title=${JSON.stringify(blob.title)} reels=${
      Array.isArray(blob.reels) ? blob.reels.length : 'n/a'
    }`,
  );
} else {
  console.error(`[smoke] loadByGuid failed: ${JSON.stringify(loadRes.error)}`);
}
const loadOk =
  loadRes.ok &&
  blob !== undefined &&
  typeof blob.title === 'string' &&
  Array.isArray(blob.reels) &&
  blob.reels.length === 3;

// REAL use (e): spawn one cube per reel from the loaded blob
const world = new World();
if (loadOk) {
  for (const reel of blob.reels) {
    world.spawn(
      {
        component: Transform,
        data: {
          posX: reel.x,
          posY: (reel.symbols.length - 2) * 0.2,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    );
  }
}
world.spawn(
  {
    component: Transform,
    data: { posX: 0, posY: 0, posZ: 3, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { directionX: -0.5, directionY: -1, directionZ: -0.3, colorR: 1, colorG: 1, colorB: 1, intensity: 1 },
});

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 4. Pixel readback ------------------------------------------------------

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
  process.exit(1);
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
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
// Sample a 5x5 grid; the 3 reel cubes spread across the centre band, so a
// grid max-distance-to-black catches the rendered geometry regardless of
// exact cube positions.
const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];
let maxDist = 0;
let maxSample = BLACK;
for (let gy = 1; gy <= 5; gy++) {
  for (let gx = 1; gx <= 5; gx++) {
    const px = Math.floor((WIDTH * gx) / 6);
    const py = Math.floor((HEIGHT * gy) / 6);
    const rgba = readRgba(px, py);
    const d = distance(rgba, BLACK);
    if (d > maxDist) {
      maxDist = d;
      maxSample = rgba;
    }
  }
}
const pixelSamples = { maxSample, maxDist: Number(maxDist.toFixed(4)) };
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict -------------------------------------------------------------

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (!structuralOk) {
  failures.push(`(c) pack-index has no '${REEL_GAME_BLOB_KIND}' row for GUID ${REEL_GAME_LEVEL_1_GUID}`);
}
if (!loadOk) {
  failures.push('(d) loadByGuid did not return a typed reel-game blob with title + 3 reels (REAL load)');
}
if (maxDist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(e) all grid samples too close to black (maxDist ${maxDist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) -- scene not rendered from blob (REAL use)`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(f) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-custom-importer smoke');
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, pack-index reel-game-blob row present, loadByGuid returned typed blob (title + 3 reels), scene rendered (maxDist=${maxDist.toFixed(4)}), RhiError count=0`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
