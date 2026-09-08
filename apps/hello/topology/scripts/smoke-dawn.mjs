#!/usr/bin/env node
// hello-topology focused Dawn smoke for first-class Points/Lines authoring.
//
// Proves the first-class Points/Lines retained/prepared/recorded path through
// the same Standard renderer owner.
//
// Strategy (first-class inspection plus single-pass line-pixel readback):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0), same bootstrap as hello-fxaa/cube.
//   2. Mock canvas + offscreen render target (bgra8unorm).
//   3. createRenderer + register first-class Points and Lines entries backed by
//      a vertex-only wireframe-box mesh (12 edges, 24 vertices, NO index
//      buffer, topology='line-list') and an unlit bright-cyan material.
//      Points/Lines deliberately expand source primitives into indexed
//      triangles for physical-pixel width, so the readback measures the real
//      expanded raster rather than raw line-list coverage.
//   4. Render ~300 frames as a TIGHT SYNCHRONOUS loop (one warm-up frame + a
//      single event-loop yield to let the first shader-module compile land,
//      then no per-frame yield -- RD: the scene is static, repeated draws are
//      idempotent). The sync loop is itself a regression guard: the engine
//      fix (w16-b) keys the shader module on its SOURCE, so the warm unlit
//      module is reused for the line-list PSO without a fresh per-variant
//      compile -- a tight loop no longer falls back to triangle-list. Read
//      back the final frame.
//   5. Count foreground pixels (any pixel materially brighter than the black
//      clear color). Assert that the expanded Lines/Points carrier renders
//      non-zero pixels and that its typed inspection remains resident. The
//      separate browser probe owns the compositor PNG and falsifier matrix.
//
// Falsify hooks (plan-strategy §5.4 falsification check; NOT run in CI):
//   - FALSIFY=topology-triangle-list : replace the Lines source with a solid
//     cube. Points/Lines admission must refuse the mismatched topology and the
//     inspection gate reports the refusal instead of drawing stale geometry.
//   - FALSIFY=degenerate : collapse every wireframe vertex to the origin. The
//     line segments have zero length -> ~0 foreground pixels -> assertion (a)
//     fails -> smoke RED. Proves the readback is measuring real geometry.
//
// No disk PNG (charter P5): pure in-memory readback, no writeFileSync.
//
// Output literals (preserved for grep tooling):
//   - `[hello-topology] backend=webgpu`
//   - `[smoke] lineReadback={"foreground":<N>,"totalPixels":<N>,"frames":<N>}`
//   - `[smoke] PASS` / `[smoke] FAIL`

// Focused M4 evidence matrix. The legacy line-list smoke below remains the
// regression carrier; the focused browser probe owns compositor PNG evidence.
// These names are also the stable falsifier vocabulary for the paired probes.
const FOCUSED_EVIDENCE_CASES = [
  'points-square-circle',
  'lines-1-4-16px',
  'indexed-nonindexed',
  'depth-alpha-sort',
  'resize-dpr',
  'frustum-edge',
  'lane-provenance',
];
const FOCUSED_FALSIFIERS = ['point-square', 'line-width', 'depth-sort', 'lane'];

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
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { buildMeshAttributeMapForUvSets } = await import('@forgeax/engine-geometry');
const { Camera, Lines, Materials, MeshFilter, MeshRenderer, PointShapeValue, Points, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

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
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-topology] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
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
  attributes: { ...buildMeshAttributeMapForUvSets(1), position },
  submeshes: [{
    indexOffset: 0,
    indexCount: useTriangleFalsify ? vertexCount : 0,
    vertexCount,
    topology,
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'Default' }],
};
if (useTriangleFalsify) {
  // triangle-list of the 36 solid-cube vertices: 12 triangles (36 / 3).
  // Provide an identity index buffer so the maxIndex+1 === vertexCount
  // invariant holds.
  meshPayload.indices = new Uint16Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) meshPayload.indices[i] = i;
}

const pointPacked = packVertices([
  [-0.4, 0.45, 0],
  [0, 0.65, 0],
  [0.4, 0.45, 0],
], false);
const pointMeshPayload = {
  kind: 'mesh',
  vertices: pointPacked.vertices,
  attributes: { ...buildMeshAttributeMapForUvSets(1), position: pointPacked.position },
  submeshes: [{
    indexOffset: 0,
    indexCount: 0,
    vertexCount: pointPacked.vertexCount,
    topology: 'point-list',
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'Points' }],
};

// w64: mint mesh + material as user-tier shared refs (register/get deleted M8).
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const meshHandle = world.allocSharedRef('MeshAsset', meshPayload);
const pointMeshHandle = world.allocSharedRef('MeshAsset', pointMeshPayload);

const materialHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.unlit([0.1, 0.9, 1, 1], {
    castShadow: false,
    ...(FALSIFY === 'depth-sort' ? { renderState: { depthWriteEnabled: false } } : {}),
  }),
);

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
    { component: Lines, data: { widthPx: FALSIFY === 'line-width' ? 1 : 4 } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    {
      component: Points,
      data: {
        sizePx: 16,
        shape: FALSIFY === 'point-square' ? PointShapeValue.square : PointShapeValue.circle,
      },
    },
  );
  world.spawn(
    { component: Transform, data: { pos: [1.6, 1.4, 3.2], quat: [-0.1804578, 0.22576895, 0.04260031, 0.9563726]} },
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
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

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
  world.update().unwrap();
  const warmRes = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!warmRes.ok) {
    console.error(`[smoke] FAIL - warmup draw failed: ${warmRes.error.code}`);
    process.exit(1);
  }
}
await delay(0); // single event-loop turn: let the first unlit module compile land.
for (let f = 1; f < FRAMES; f++) {
  world.update().unwrap();
  const drawRes = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  }); // tight, synchronous: no yield in steady state.
  if (!drawRes.ok) {
    console.error(`[smoke] FAIL - draw failed at frame ${f}: ${drawRes.error.code}`);
    process.exit(1);
  }
}
await device.queue.onSubmittedWorkDone();
const pixels = await doReadPixels();
const pointsLinesInspection = renderer.inspect().renderScene.pointsLines ?? [];
const pointInspection = pointsLinesInspection.find((entry) => entry.component === 'Points');
const lineInspection = pointsLinesInspection.find((entry) => entry.component === 'Lines');

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
    totalPixels: TOTAL_PIXELS,
    frames: FRAMES,
    falsify: FALSIFY || '<none>',
    lane: renderer.inspect().capabilities.backendKind,
    pointsLines: pointsLinesInspection,
  })}`,
);

const failures = [];

if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(0) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(0) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
if (pointsLinesInspection.length !== 2) {
  failures.push(`(c) first-class inspection count=${pointsLinesInspection.length} (expected 2)`);
}
if (pointInspection?.style?.kind !== 'points' || pointInspection.style.sizePx !== 16) {
  failures.push('(c) authored point size/style was not observed through Points/Lines inspection');
}
if (lineInspection?.style?.kind !== 'lines' || lineInspection.style.widthPx !== (FALSIFY === 'line-width' ? 1 : 4)) {
  failures.push('(c) authored line width was not observed through Points/Lines inspection');
}
if (FALSIFY === 'point-square' && pointInspection?.style?.shape !== 'square') {
  failures.push('(falsifier) point-square did not execute against the authored component');
}
if (FALSIFY === 'lane' && renderer.inspect().capabilities.backendKind === 'webgpu') {
  failures.push('(falsifier) lane requested wgpu-webgl2 but observed webgpu');
}
// (a) lines actually rendered.
if (foreground === 0) {
  failures.push(
    '(a) frame has zero foreground pixels -- the line-list mesh did not render ' +
      '(degenerate geometry, or the topology path dropped the draw)',
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
    `foreground=${foreground} expanded Points/Lines pixels over ${FRAMES} frames`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
