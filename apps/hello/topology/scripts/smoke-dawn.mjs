#!/usr/bin/env node
// hello-topology headless smoke (feat-20260604-mesh-topology-debug-draw / M6 / w17).
//
// Proves AC-11: a vertex-only MeshAsset authored with topology='line-list'
// renders as DISCRETE line segments through the non-indexed draw path, NOT a
// filled triangle face.
//
// Strategy (single-pass line-pixel readback + falsifiable inversion):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0), same bootstrap as hello-fxaa/cube.
//   2. Mock canvas + offscreen render target (bgra8unorm).
//   3. createRenderer + register the demo's vertex-only wireframe-box mesh
//      (12 edges, 24 vertices, NO index buffer, topology='line-list') + an
//      unlit bright-cyan material. The 12 thin edges cover a small fraction
//      of the frame.
//   4. Render ~300 frames as a TIGHT SYNCHRONOUS loop (one warm-up frame + a
//      single event-loop yield to let the first shader-module compile land,
//      then no per-frame yield -- RD: the scene is static, repeated draws are
//      idempotent). The sync loop is itself a regression guard: the engine
//      fix (w16-b) keys the shader module on its SOURCE, so the warm unlit
//      module is reused for the line-list PSO without a fresh per-variant
//      compile -- a tight loop no longer falls back to triangle-list. Read
//      back the final frame.
//   5. Count foreground pixels (any pixel materially brighter than the black
//      clear color). Assert:
//        (a) foreground > 0                   -- lines actually rendered
//        (b) foreground < FILLED_FACE_CEILING -- it is a sparse wireframe,
//            NOT a filled triangle face. A silent revert to triangle-list
//            (topology dropped to the eager triangle-list PSO) renders a
//            filled face that overshoots the ceiling -> red. This two-sided
//            band is the discriminating power: a passing run proves the
//            line-list PSO is actually in effect.
//
// Falsify hooks (plan-strategy §5.4 falsification check; NOT run in CI):
//   - FALSIFY=topology-triangle-list : register a SOLID filled cube (36
//     vertices, 12 triangles, topology='triangle-list', indexed so the
//     strip/empty gates pass). This is the geometry the engine would draw if
//     it silently dropped the line-list topology and fell back to the eager
//     triangle-list PSO. The filled silhouette floods ~36% of the frame, far
//     past FILLED_FACE_CEILING -> assertion (b) fails -> smoke RED. Proves
//     the line-list path is load-bearing (the wireframe edges as a degenerate
//     triangle-list would NOT fill, so the falsify uses the real filled cube
//     to model the failure mode the demo guards against).
//   - FALSIFY=degenerate : collapse every wireframe vertex to the origin. The
//     line segments have zero length -> ~0 foreground pixels -> assertion (a)
//     fails -> smoke RED. Proves the readback is measuring real geometry.
//
// No disk PNG (charter P5): pure in-memory readback, no writeFileSync.
//
// Output literals (preserved for grep tooling):
//   - `[hello-topology] backend=webgpu`
//   - `[smoke] lineReadback={"foreground":<N>,"ceiling":<N>,"totalPixels":<N>,"frames":<N>}`
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

// A bright-cyan unit-cube wireframe (12 thin edges) viewed obliquely covers a
// small fraction of the frame. A SOLID filled cube (the falsify geometry) at
// the same camera fills ~36% of the frame. 8% of the frame cleanly separates
// the two: line segments land well under it, a filled silhouette blows past
// it.
const FILLED_FACE_CEILING = Math.floor(TOTAL_PIXELS * 0.08); // 38400 px
// A pixel counts as foreground when any color channel is clearly above the
// black clear color (guards against AA fringe noise being counted).
const FOREGROUND_CHANNEL_MIN = 24;

const FALSIFY = process.env.FALSIFY ?? '';

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
  console.error('  rerun: pnpm --filter @forgeax/hello-topology smoke');
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
  console.error('  run `pnpm --filter @forgeax/hello-topology build` first');
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

console.log(`[hello-topology] backend=${renderer.backend}`);

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

// --- 4. Geometry builders ----------------------------------------------------

// 12-float interleaved layout: position vec3 + normal vec3 + uv vec2 + tangent vec4.
const FLOATS_PER_VERTEX = 12;

const HALF = 0.8;
// 8 cube corners.
const CORNERS = [
  [-HALF, -HALF, -HALF], // 0
  [HALF, -HALF, -HALF], // 1
  [HALF, HALF, -HALF], // 2
  [-HALF, HALF, -HALF], // 3
  [-HALF, -HALF, HALF], // 4
  [HALF, -HALF, HALF], // 5
  [HALF, HALF, HALF], // 6
  [-HALF, HALF, HALF], // 7
];
// 12 cube edges as corner-index pairs -- the demo's wireframe (line-list).
const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // back face
  [4, 5], [5, 6], [6, 7], [7, 4], // front face
  [0, 4], [1, 5], [2, 6], [3, 7], // connecting edges
];
// 6 faces x 2 triangles = 12 triangles = 36 vertices, CCW outward -- the SOLID
// cube used only by the FALSIFY=topology-triangle-list arm to model the
// "topology dropped to the eager triangle-list PSO" failure mode (a filled
// silhouette).
const TRIANGLES = [
  [0, 1, 2], [0, 2, 3], // back  (-z)
  [5, 4, 7], [5, 7, 6], // front (+z)
  [4, 0, 3], [4, 3, 7], // left  (-x)
  [1, 5, 6], [1, 6, 2], // right (+x)
  [3, 2, 6], [3, 6, 7], // top   (+y)
  [4, 5, 1], [4, 1, 0], // bottom(-y)
];

/**
 * Pack a flat list of corner triples into the engine's interleaved 12-float
 * vertex buffer + a parallel position attribute. `degenerate` collapses every
 * vertex to the origin (zero-length / zero-area) for the FALSIFY=degenerate
 * inversion.
 */
function packVertices(corners, degenerate) {
  const vertexCount = corners.length;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  const position = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const corner = degenerate ? [0, 0, 0] : corners[v];
    const base = v * FLOATS_PER_VERTEX;
    vertices[base + 0] = corner[0];
    vertices[base + 1] = corner[1];
    vertices[base + 2] = corner[2];
    position[v * 3 + 0] = corner[0];
    position[v * 3 + 1] = corner[1];
    position[v * 3 + 2] = corner[2];
  }
  return { vertices, position, vertexCount };
}

/** The demo geometry: 24 vertices (2 per edge), drawn as 12 line segments. */
function buildWireframe(degenerate) {
  const corners = [];
  for (const [a, b] of EDGES) {
    corners.push(CORNERS[a], CORNERS[b]);
  }
  return packVertices(corners, degenerate);
}

/** The falsify geometry: 36 vertices (12 triangles), a solid filled cube. */
function buildSolidCube() {
  const corners = [];
  for (const tri of TRIANGLES) {
    for (const ci of tri) corners.push(CORNERS[ci]);
  }
  return packVertices(corners, false);
}

// Register the mesh. Normal path: vertex-only wireframe line-list (no indices,
// non-indexed pass.draw). Falsify path topology-triangle-list: a SOLID cube
// triangle-list with an index buffer (so the validateMeshPayload strip/empty
// gates stay green) -- the filled geometry the engine would draw if it dropped
// the line-list topology and fell back to the eager triangle-list PSO.
const useTriangleFalsify = FALSIFY === 'topology-triangle-list';
const useDegenerate = FALSIFY === 'degenerate';
const { vertices, position, vertexCount } = useTriangleFalsify
  ? buildSolidCube()
  : buildWireframe(useDegenerate);

const topology = useTriangleFalsify ? 'triangle-list' : 'line-list';
const meshPayload = {
  kind: 'mesh',
  vertices,
  attributes: { position },
  submeshes: [{
    indexOffset: 0,
    indexCount: useTriangleFalsify ? vertexCount : 0,
    vertexCount,
    topology,
  }],
};
if (useTriangleFalsify) {
  // triangle-list of the 36 solid-cube vertices: 12 triangles (36 / 3).
  // Provide an identity index buffer so the maxIndex+1 === vertexCount
  // invariant holds.
  meshPayload.indices = new Uint16Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) meshPayload.indices[i] = i;
}

// w64: mint mesh + material as user-tier shared refs (register/get deleted M8).
const world = new World();
const meshHandle = world.allocSharedRef('MeshAsset', meshPayload);

const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues: {
    baseColor: [0.1, 0.9, 1.0],
  },
});

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 5. Scene + readback helpers --------------------------------------------

function spawnScene(world) {
  world.spawn(
    { component: Transform, data: { quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  );
  world.spawn(
    { component: Transform, data: { pos: [1.6, 1.4, 3.2], quat: [0, 0, 0, 1]} },
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
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

// --- 6. Error tracker + render loop -----------------------------------------

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

spawnScene(world);

// Render FRAMES times to exercise the steady-state path the demo runs under
// rAF; the scene is static so the final frame is representative.
//
// Warmup model (post-engine-fix): the line-list PSO is built lazily through
// the per-MaterialShader pipeline cache, whose shader-module factory caches an
// ASYNC `pack.createShaderModule` (createRenderer.ts makeShaderDeviceAdapter).
// The very first sync request returns `rhi-not-available`; the compiled module
// lands in the adapter cache only after the async build's `.then()` microtask
// runs, which needs ONE event-loop turn. So we draw a single warm-up frame,
// `await delay(0)` ONCE to let that first compile land, then run the rest of
// the loop FULLY SYNCHRONOUSLY -- no per-frame yield.
//
// This is the load-bearing proof of the engine fix (w16-b): the shader module
// is now keyed on the shader SOURCE, not the topology-bearing pipeline cache
// key, so the warm unlit module is reused for the line-list PSO and every
// later topology / renderState / HDR variant -- no fresh async compile per
// variant. Before w16-b, the topology-bearing module key forced a new compile
// on (and only resolved after another yield for) every new variant, so a tight
// loop silently fell back to the eager TRIANGLE-LIST `unlitPipeline` and the
// wireframe rendered as a filled blob. A single warm-up turn is acceptable
// (one compile); a per-frame yield would mean the engine fix did not work.
{
  const warmRes = renderer.draw([world], { owner: 0 });
  if (!warmRes.ok) {
    console.error(`[smoke] FAIL - warmup draw failed: ${warmRes.error.code}`);
    process.exit(1);
  }
}
await delay(0); // single event-loop turn: let the first unlit module compile land.
for (let f = 1; f < FRAMES; f++) {
  const drawRes = renderer.draw([world], { owner: 0 }); // tight, synchronous: no yield in steady state.
  if (!drawRes.ok) {
    console.error(`[smoke] FAIL - draw failed at frame ${f}: ${drawRes.error.code}`);
    process.exit(1);
  }
}
await device.queue.onSubmittedWorkDone();
const pixels = await doReadPixels();

// --- 7. Verdict --------------------------------------------------------------

let foreground = 0;
for (let i = 0; i < pixels.length; i += 4) {
  if (
    pixels[i] >= FOREGROUND_CHANNEL_MIN ||
    pixels[i + 1] >= FOREGROUND_CHANNEL_MIN ||
    pixels[i + 2] >= FOREGROUND_CHANNEL_MIN
  ) {
    foreground++;
  }
}

console.log(
  `[smoke] lineReadback=${JSON.stringify({
    foreground,
    ceiling: FILLED_FACE_CEILING,
    totalPixels: TOTAL_PIXELS,
    frames: FRAMES,
    falsify: FALSIFY || '<none>',
  })}`,
);

const failures = [];

if (renderer.backend !== 'webgpu') {
  failures.push(`(0) backend=${renderer.backend} (expected webgpu)`);
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(0) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
// (a) lines actually rendered.
if (foreground === 0) {
  failures.push(
    '(a) frame has zero foreground pixels -- the line-list mesh did not render ' +
      '(degenerate geometry, or the topology path dropped the draw)',
  );
}
// (b) sparse wireframe, not a filled face.
if (foreground >= FILLED_FACE_CEILING) {
  failures.push(
    `(b) foreground ${foreground} >= ceiling ${FILLED_FACE_CEILING} -- the mesh ` +
      'rendered as a FILLED face, not discrete line segments. topology may have ' +
      "reverted to 'triangle-list' (charter P3: check MeshAsset.topology threading " +
      'into the per-topology PSO).',
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, RhiError count=${errors.length}, ` +
    `foreground=${foreground} in band (0, ${FILLED_FACE_CEILING}) over ${FRAMES} frames`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
