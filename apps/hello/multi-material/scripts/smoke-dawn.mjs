#!/usr/bin/env node
// hello-multi-material headless smoke
// (feat-20260608-mesh-multi-section-primitive-multi-material-slot / M5 / w22).
//
// Proves AC-08: a single MeshAsset carrying TWO submeshes (triangle-list quad
// + line-list wireframe box) bound to TWO distinct MaterialAssets through
// MeshRenderer.materials[] renders both prims in the same frame -- the red
// filled quad pixels coexist with cyan line-stroke pixels -> two distinct
// material colors are detectable post-render.
//
// Strategy (mirrors hello-topology smoke skeleton; structural readback):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (bgra8unorm).
//   3. createRenderer + register the demo's hand-built multi-prim mesh
//      (4 quad verts + 8 wireframe verts; index buffer concatenates quad
//      indices then line-list indices) + two unlit materials (red + cyan).
//   4. Render ~300 frames as a tight synchronous loop (one warm-up frame
//      with an event-loop yield to land first shader compile, then no
//      per-frame yield -- scene is static, repeated draws are idempotent).
//   5. Read back final frame. Count:
//        (a) red-dominant pixels   (R > 128 && R - max(G,B) >= 32)
//        (b) cyan-dominant pixels  (G > 96 && B > 96 && R < 96)
//      Assert BOTH counts > 0 -- proves both submeshes rendered with
//      different materials in the same frame. A single-material mode (e.g.
//      MeshRenderer.materials = [red, red]) would bring cyan pixels to 0.
//
// Falsify hooks (plan-strategy 5.4 falsification check; NOT run in CI):
//   - FALSIFY=truncate-materials : register MeshRenderer with materials=[red]
//     while submeshes.length===2 -> render-system-extract throws
//     'mesh-renderer-material-count-mismatch' AssetError -> renderer.onError
//     fires -> smoke FAIL (no cyan pixels + non-empty errors). Proves the
//     count-mismatch fail-fast (M2 / w11) is load-bearing.
//   - FALSIFY=duplicate-material : materials=[red, red]; both submeshes paint
//     red, cyan count drops to 0 -> assertion (b) fails. Proves the
//     positional materials[i] -> submeshes[i] binding is load-bearing.
//
// Output literals (preserved for grep tooling):
//   - `[hello-multi-material] backend=webgpu`
//   - `[smoke] colorReadback={"red":<N>,"cyan":<N>,"totalPixels":<N>,"frames":<N>}`
//   - `[smoke] PASS` / `[smoke] FAIL`

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const CLEAR_RGBA = [0, 0, 0, 1];
const TOTAL_PIXELS = WIDTH * HEIGHT;
const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);

const FALSIFY = process.env.FALSIFY ?? '';

const here = dirname(fileURLToPath(import.meta.url));

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-multi-material smoke');
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
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
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
    usage: 0x10 | 0x04 | 0x01,
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

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = enginePkg;

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
let MANIFEST_URL;
try {
  MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
} catch (err) {
  console.error(
    `[smoke] FAIL - missing built manifest at ${MANIFEST_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  run `pnpm --filter @forgeax/hello-multi-material build` first');
  process.exit(1);
}

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-multi-material] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
if (!renderer.ready) {
  console.error('[smoke] FAIL - renderer.ready is null');
  process.exit(1);
}
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// --- 4. Geometry (multi-prim, mixed-topology) -------------------------------

const FLOATS_PER_VERTEX = 12;

function buildMultiPrimMesh() {
  const half = 0.6;
  const lineHalf = 0.7;
  const lineZ = 0.02;
  const quadCorners = [
    [-half, -half, 0],
    [+half, -half, 0],
    [+half, +half, 0],
    [-half, +half, 0],
  ];
  const lineCorners = [
    [-lineHalf, -lineHalf, lineZ],
    [+lineHalf, -lineHalf, lineZ],
    [+lineHalf, +lineHalf, lineZ],
    [-lineHalf, +lineHalf, lineZ],
    [-lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, +lineHalf * 0.5, lineZ],
    [-lineHalf * 0.5, +lineHalf * 0.5, lineZ],
  ];
  const totalVerts = quadCorners.length + lineCorners.length;
  const vertices = new Float32Array(totalVerts * FLOATS_PER_VERTEX);
  const positions = new Float32Array(totalVerts * 3);
  let v = 0;
  for (const corner of [...quadCorners, ...lineCorners]) {
    const base = v * FLOATS_PER_VERTEX;
    vertices[base + 0] = corner[0];
    vertices[base + 1] = corner[1];
    vertices[base + 2] = corner[2];
    positions[v * 3 + 0] = corner[0];
    positions[v * 3 + 1] = corner[1];
    positions[v * 3 + 2] = corner[2];
    v++;
  }
  const quadIndices = [0, 1, 2, 0, 2, 3];
  const outerSegs = [
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ];
  const innerSegs = [
    [8, 9],
    [9, 10],
    [10, 11],
    [11, 8],
  ];
  const lineIndices = [];
  for (const [a, b] of [...outerSegs, ...innerSegs]) {
    lineIndices.push(a, b);
  }
  const indices = new Uint16Array([...quadIndices, ...lineIndices]);
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes: { position: positions },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: quadIndices.length,
        vertexCount: 4,
        topology: 'triangle-list',
      },
      {
        indexOffset: quadIndices.length,
        indexCount: lineIndices.length,
        vertexCount: 8,
        topology: 'line-list',
      },
    ],
  };
}

// w64: mint mesh + materials as user-tier shared refs (register/get deleted M8).
const world = new World();
const meshHandle = world.allocSharedRef('MeshAsset', buildMultiPrimMesh());

function mintUnlit(rgb) {
  return world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: { baseColor: rgb },
  });
}

const redHandle = mintUnlit([1.0, 0.15, 0.15]);
const cyanHandle = mintUnlit([0.1, 0.9, 1.0]);

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 5. Scene -----------------------------------------------------------------

function spawnScene(world) {
  // Falsify modes manipulate the materials array to model failure modes:
  //   - truncate-materials: materials=[red] (1 element) vs submeshes.length=2
  //     -> mesh-renderer-material-count-mismatch fail-fast.
  //   - duplicate-material: materials=[red, red] -> both prims paint red, cyan
  //     count drops to 0 -> assertion (b) fails.
  let materials;
  if (FALSIFY === 'truncate-materials') {
    materials = [redHandle];
  } else if (FALSIFY === 'duplicate-material') {
    materials = [redHandle, redHandle];
  } else {
    materials = [redHandle, cyanHandle];
  }
  world.spawn(
    { component: Transform, data: { quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2.5], quat: [0, 0, 0, 1]} },
    {
      component: Camera,
      data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    },
  );
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function doReadPixels() {
  if (!renderTarget) throw new Error('renderTarget never allocated');
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
  });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(0x01);
  const mapped = buf.getMappedRange();
  const raw = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      // bug-20260610 v18: swap-chain unified to rgba8unorm; byte order is RGBA, no swap needed.
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

spawnScene(world);

// First frame + tiny yield to let the first shader-module compile land.
renderer.draw([world], { owner: 0 });
await delay(20);

let frames = 1;
for (let i = 1; i < FRAMES; i++) {
  renderer.draw([world], { owner: 0 });
  frames++;
}

const pixels = await doReadPixels();

// Pixel classifiers:
//   red-dominant: clearly red, R high, G+B low.
//   cyan-dominant: cyan-ish, G + B high, R low.
let redCount = 0;
let cyanCount = 0;
for (let i = 0; i < TOTAL_PIXELS; i++) {
  const r = pixels[i * 4 + 0] ?? 0;
  const g = pixels[i * 4 + 1] ?? 0;
  const b = pixels[i * 4 + 2] ?? 0;
  if (r > 128 && r - Math.max(g, b) >= 32) {
    redCount++;
  } else if (g > 96 && b > 96 && r < 96) {
    cyanCount++;
  }
}

console.log(
  `[smoke] colorReadback=${JSON.stringify({
    red: redCount,
    cyan: cyanCount,
    totalPixels: TOTAL_PIXELS,
    frames,
  })}`,
);

let failed = false;
if (renderer.backend !== 'webgpu') {
  console.error(`[smoke] FAIL - (a) backend=${renderer.backend} != 'webgpu'`);
  failed = true;
}
if (frames < FRAMES) {
  console.error(`[smoke] FAIL - (b) frames=${frames} < ${FRAMES}`);
  failed = true;
}
if (redCount === 0) {
  console.error(
    '[smoke] FAIL - (c) redCount=0; the triangle-list submesh did not render its material -- ' +
      'submeshes[0] -> materials[0] binding is broken or per-submesh drawIndexed missing',
  );
  failed = true;
}
if (cyanCount === 0) {
  console.error(
    '[smoke] FAIL - (d) cyanCount=0; the line-list submesh did not render its material -- ' +
      'submeshes[1] -> materials[1] binding is broken or mixed-topology PSO selection failed',
  );
  failed = true;
}
if (errors.length > 0) {
  console.error(
    `[smoke] FAIL - (e) renderer reported ${errors.length} RhiError(s): ${JSON.stringify(errors.slice(0, 5))}`,
  );
  failed = true;
}

if (failed) {
  console.error('[smoke] FAIL');
  process.exit(1);
}

console.log(
  `[smoke] PASS red=${redCount} cyan=${cyanCount} (both > 0; multi-prim + mixed-topology + ` +
    `materials[i] <-> submeshes[i] index alignment confirmed over ${frames} frames)`,
);
process.exit(0);
