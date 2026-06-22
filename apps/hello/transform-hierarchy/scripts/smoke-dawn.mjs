#!/usr/bin/env node
// hello-transform-hierarchy headless smoke
// (feat-20260531-render-consume-global-transform-hierarchy / M3 / w12).
//
// Strategy (single-World dual-frame "parent moves, child follows" pixel diff):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Build ONE World that wires the hierarchy consume path exactly like the
//      demo main.ts: registerPropagateTransforms(world). Spawn a non-identity
//      parent cube, a child cube carrying ChildOf{parent} + a local +Y offset,
//      and a static reference sphere that is NOT in the hierarchy.
//   4. Frame A (parent at rest): world.update() (runs propagateTransforms so
//      the child's Transform.world is composed) -> renderer.draw -> readback
//      pixelsA.
//   5. Stability re-render: world.update() + draw + readback pixelsAA WITHOUT
//      moving the parent. Assert pixelsA ~= pixelsAA (parent-static reference
//      frame is stable; AC-08 "parent stationary reference frame is stable").
//   6. Frame B (parent moved): world.set(parent, Transform, { posX: ... }) ->
//      world.update() (re-runs propagate; child's Transform.world follows the
//      parent) -> draw -> readback pixelsB.
//   7. Diff A vs B: per-pixel byte comparison. Assert diffCount > 0.1% of
//      total pixels -- this is the machine proof that moving the PARENT moved
//      the CHILD's rendered world position (the child has no Transform write
//      of its own between frames; the only thing that changed is the parent's
//      Transform propagated down the ChildOf edge).
//   8. Both frames must be non-black individually (geometries rendered).
//   9. No reference PNG reads/writes. No PNG ever lands in the engine repo
//      worktree.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-transform-hierarchy] backend=webgpu`
//   - `[smoke] parentMoveDiff={"diffCount":<N>,"threshold":<N>,...}`
//   - `[smoke] PASS`
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual diffCount / stabilityDiff vs thresholds so AI users can self-diagnose.

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
// AC-08: >0.1% of total pixels. floor(800*600*0.001) = 480.
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.001);
// Stability tolerance: two renders of the identical scene must match within a
// tiny pixel-count budget (dawn rasterisation is deterministic, so this is
// effectively 0; the small budget absorbs any nondeterministic dither).
const STABILITY_MAX_DIFF = Math.floor(TOTAL_PIXELS * 0.0001); // 48

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node setup ----------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-transform-hierarchy smoke');
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
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- 2. Mock canvas with offscreen render target --------------------------

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

// --- 3. Engine imports + renderer bootstrap ---------------------------------

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  ChildOf,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  HANDLE_SPHERE,
  MeshFilter,
  MeshRenderer,
  perspective,
  registerPropagateTransforms,
  Transform,
} = enginePkg;

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
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
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-transform-hierarchy] backend=${renderer.backend}`);

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

// Mint standard PBR material as a user-tier shared ref (same as demo main.ts).
const world = new World();
const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues: {
    baseColor: [0.7, 0.7, 0.7],
    metallic: 0.0,
    roughness: 0.4,
  },
});

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 4. Build the ONE World with the hierarchy consume path wired -----------

// The line that makes the hierarchy take effect: propagate derives every
// entity's Transform.world each frame (the world mat4 lives on Transform).
registerPropagateTransforms(world);

const PARENT_X_REST = -0.6;
const PARENT_X_MOVED = 1.0;

const parent = world
  .spawn(
    {
      component: Transform,
      data: {
        posX: PARENT_X_REST,
        posY: -0.4,
        posZ: 0,
        quatW: 1,
        scaleX: 0.4,
        scaleY: 0.4,
        scaleZ: 0.4,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

// Child: ChildOf{parent} + local +Y offset. No Transform write happens to the
// child between frames -- its rendered world position changes ONLY because the
// parent's Transform.world propagates down the ChildOf edge.
world
  .spawn(
    {
      component: Transform,
      data: { posX: 0, posY: 2.0, posZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
    },
    { component: ChildOf, data: { parent } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

// Static reference sphere -- not in the hierarchy.
world
  .spawn(
    {
      component: Transform,
      data: { posX: 1.4, posY: 0.0, posZ: 0, quatW: 1, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

world
  .spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.4,
      directionY: -0.6,
      directionZ: -0.7,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.5,
    },
  })
  .unwrap();

world
  .spawn(
    { component: Transform, data: { posZ: 7 } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  )
  .unwrap();

// --- 5. readback helper -----------------------------------------------------

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

  // BGRA -> RGBA repack + pad removal.
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

function countNonBlack(pixels) {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) n++;
  }
  return n;
}

function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      n++;
    }
  }
  return n;
}

// --- 6. Error tracker -----------------------------------------------------

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

// --- 7. Frame A (parent at rest) -------------------------------------------

world.update(); // runs propagateTransforms so child Transform.world is composed
const drawARes = renderer.draw(world);
if (!drawARes.ok) {
  console.error(`[smoke] FAIL - draw (frame A) failed: ${drawARes.error.code}`);
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const pixelsA = await doReadPixels();

// --- 8. Stability re-render (parent still at rest) -------------------------

world.update();
const drawAARes = renderer.draw(world);
if (!drawAARes.ok) {
  console.error(`[smoke] FAIL - draw (stability frame) failed: ${drawAARes.error.code}`);
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const pixelsAA = await doReadPixels();

// --- 9. Frame B (parent moved -> child must follow) ------------------------

const setRes = world.set(parent, Transform, { posX: PARENT_X_MOVED });
if (!setRes.ok) {
  console.error(`[smoke] FAIL - world.set(parent move) failed: ${setRes.error.code}`);
  process.exit(1);
}
world.update(); // re-runs propagateTransforms; child Transform.world follows parent
const drawBRes = renderer.draw(world);
if (!drawBRes.ok) {
  console.error(`[smoke] FAIL - draw (frame B) failed: ${drawBRes.error.code}`);
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const pixelsB = await doReadPixels();

// --- 10. Verdict -----------------------------------------------------------

const failures = [];

// (a) Backend must be webgpu.
if (renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
}

// (b) All frames must produce valid buffers.
for (const [label, px] of [
  ['A', pixelsA],
  ['AA', pixelsAA],
  ['B', pixelsB],
]) {
  if (px.length !== TOTAL_PIXELS * 4) {
    failures.push(`(b) frame ${label} pixel buffer size mismatch: ${px.length} != ${TOTAL_PIXELS * 4}`);
  }
}

// (c) RhiError must be zero. The "hierarchy wired" guard is the parent-move
// diff below: with the unified Transform the world column always exists, so a
// child always follows once propagate runs (no misconfig error class to catch).
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (d) Frames must be non-black (geometries rendered).
const nonBlackA = countNonBlack(pixelsA);
const nonBlackB = countNonBlack(pixelsB);
if (nonBlackA === 0) failures.push('(d) frame A is completely black (geometries not rendered)');
if (nonBlackB === 0) failures.push('(d) frame B is completely black (geometries not rendered)');

// (e) Stability: two renders of the rest scene must match (AC-08 parent-static
// reference frame is stable).
const stabilityDiff = countDiff(pixelsA, pixelsAA);
if (stabilityDiff > STABILITY_MAX_DIFF) {
  failures.push(
    `(e) parent-static reference frame unstable: stabilityDiff ${stabilityDiff} > ${STABILITY_MAX_DIFF}` +
      ` -- two identical-scene renders should be pixel-stable (charter P3: check for nondeterministic render state)`,
  );
}

// (f) Parent-move diff: moving the PARENT must move the CHILD's rendered world
// position (AC-08 child-follows-parent-displacement). diffCount > threshold.
const diffCount = countDiff(pixelsA, pixelsB);
const diffPct = ((diffCount / TOTAL_PIXELS) * 100).toFixed(4);
console.log(
  `[smoke] parentMoveDiff=${JSON.stringify({
    diffCount,
    threshold: DIFF_THRESHOLD,
    totalPixels: TOTAL_PIXELS,
    pct: diffPct,
    stabilityDiff,
    stabilityMax: STABILITY_MAX_DIFF,
    nonBlackA,
    nonBlackB,
  })}`,
);

if (diffCount <= DIFF_THRESHOLD) {
  failures.push(
    `(f) parent-move pixel diff ${diffCount} <= threshold ${DIFF_THRESHOLD} (${diffPct}%)` +
      ` -- child did NOT follow the parent's world displacement` +
      ` (charter P3: check registerPropagateTransforms(world) is wired and the` +
      ` extract stage reads Transform.world for ChildOf entities)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, RhiError count=${errors.length}, ` +
    `nonBlackA=${nonBlackA}, nonBlackB=${nonBlackB}, stabilityDiff=${stabilityDiff} <= ${STABILITY_MAX_DIFF}, ` +
    `parentMoveDiff=${diffCount} > threshold=${DIFF_THRESHOLD} (${diffPct}%)`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
