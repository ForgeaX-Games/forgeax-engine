#!/usr/bin/env node
// hello-culling headless smoke (feat-20260528-frustum-culling M5 / w13;
// extended in feat-20260608-mesh-ssbo-dynamic-grow M5 to stress the SSBO
// grow path with GRID_SIZE=46 -> 2116 entities crossing the 1024->2048
// initial-grow boundary).
//
// Strategy: drive the engine ECS path with a NxN cube grid and a revolving
// camera. Verify:
//   (a) backend=webgpu
//   (b) frames >= 300
//   (c) pixel readback epsilon <= 0.05
//   (d) at least one frame has culled > 0 (frustum culling is active)
//   (e) Renderer.onError count == 0
//   (f) no 'queue-write-buffer-out-of-bounds' string in console output
//       (proves the SSBO never overflows its bound buffer; AC-15)
//   (g) RhiError fan-out count == 0 (dual-channel observability; AC-13)
//   (h) mesh-ssbo-capacity-exceeded + mesh-ssbo-ceiling-reached event
//       count == 0 (AC-13: post-grow steady state should be silent)
//   (i) [mesh-ssbo] info line count >= 1 (AC-11 + AC-12: proves the grow
//       hook actually fired during the run; with GRID_SIZE=46 = 2116
//       entities the initial 1024->2048 grow MUST happen on the first
//       frame, so 0 lines = grow path never reached and the AC-12 stress
//       expectation is unverified)
//   (j) culling semantic guard preserved via the half of the grid that
//       keeps `frustumCulled=1` (every-other-cube checkerboard): of those
//       1058 cubes, the narrow-fov orbit camera leaves >= 80% outside the
//       frustum every frame, so maxVisible / total <= 0.20 on the
//       culling-active subset (plan-strategy 2.D-2: SSBO stress + frustum
//       culling co-exist -- the opt-out half drives the SSBO size, the
//       opt-in half drives the culling stat)

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;
// 46 x 46 = 2116 entities -- crosses the 1024 -> 2048 initial-grow boundary
// on the first draw to exercise the SSBO dynamic grow path (AC-12 stress).
const GRID_SIZE = 46;
const GRID_SPACING = 3;

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Stdout tap for [culling] / [mesh-ssbo] log lines. We intercept BOTH
// console.log (engine + smoke status) and console.info (where the grow
// hook emits its `[mesh-ssbo] grew slotCount...` dev-mode line via
// AC-11) so the post-run grep can count grow events.
const stdoutLines = [];
const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
const tap = (forward) =>
  (...args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    stdoutLines.push(line);
    forward(...args);
  };
console.log = tap(originalConsoleLog);
console.info = tap(originalConsoleInfo);

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

// --- 2. Mock canvas ---

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

// --- 3. Drive engine ECS path ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const geometryPkg = await import('@forgeax/engine-geometry');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;

const world = new World();

// Spawn DirectionalLight
world.spawn({
  component: DirectionalLight,
  data: {
    directionX: -0.5, directionY: -1, directionZ: -0.3,
    colorR: 1, colorG: 1, colorB: 1, intensity: 1,
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[culling] backend=${renderer.backend}`);

const errors = [];
let meshSsboEventCount = 0;
let rhiErrorCount = 0;
const MESH_SSBO_CODES = new Set([
  'mesh-ssbo-capacity-exceeded',
  'mesh-ssbo-ceiling-reached',
]);
renderer.onError((err) => {
  errors.push({ code: err.code, hint: err.hint, detail: err.detail });
  if (MESH_SSBO_CODES.has(err.code)) meshSsboEventCount++;
  // Every fan-out callback is a RhiError surface (the registry only
  // fires structured RhiError objects; AC-10 / AC-13).
  rhiErrorCount++;
});

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// Register a custom cube mesh with a known AABB through the renderer's
// asset registry. The built-in HANDLE_CUBE uses engine-internal handle
// values; using a custom mesh ensures the AABB lookup path works on the
// dawn-node mock canvas path.
const { createBoxGeometry } = geometryPkg;
const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
if (!boxResult.ok) {
  console.error(`[smoke] FAIL - createBoxGeometry failed: ${boxResult.error.code}`);
  process.exit(1);
}
const customCubeHandle = world.allocSharedRef('MeshAsset', boxResult.value);

// Spawn cubes AFTER the renderer is ready (assets must be registered
// so AABB lookup succeeds). Half opt out of culling (frustumCulled=0) so
// validatedOrdered.length stays >= 1058 every frame, forcing the SSBO
// grow path to fire on the first draw (AC-11 + AC-12 stress); the other
// half keeps the default frustumCulled=1 so the demo's culling stat
// stays observably active (mirrors apps/hello/culling/src/main.ts).
for (let ix = 0; ix < GRID_SIZE; ix++) {
  for (let iz = 0; iz < GRID_SIZE; iz++) {
    const posX = (ix - (GRID_SIZE - 1) / 2) * GRID_SPACING;
    const posZ = (iz - (GRID_SIZE - 1) / 2) * GRID_SPACING;
    const culled = (ix + iz) % 2 === 0 ? 1 : 0;
    world.spawn(
      {
        component: Transform,
        data: {
          posX, posY: 0, posZ,
          quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
          scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7,
        },
      },
      { component: MeshFilter, data: { assetHandle: customCubeHandle } },
      { component: MeshRenderer, data: { frustumCulled: culled } },
    );
  }
}

// Spawn camera — positioned to see a subset of cubes
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 4, posZ: 6,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: { fov: Math.PI / 5, aspect: 16 / 9, near: 0.1, far: 30 },
  },
).unwrap();

// --- 4. Frame loop ---

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
let maxCulled = 0;
let maxVisibleRatio = 0;
let maxVisible = 0;
let lastTotal = 0;
let angle = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
  angle += 0.003;
  const camDist = 8;
  const camX = Math.sin(angle) * camDist;
  const camZ = Math.cos(angle) * camDist;

  // Orbit camera around the grid
  world.set(cameraEntity, Transform, {
    posX: camX, posY: 4, posZ: camZ,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
    scaleX: 1, scaleY: 1, scaleZ: 1,
  });

  const r = renderer.draw(world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);

  const stats = renderer.frustumStats;
  if (stats.culled > maxCulled) maxCulled = stats.culled;
  const visible = stats.total - stats.culled;
  if (visible > maxVisible) maxVisible = visible;
  const ratio = stats.total > 0 ? visible / stats.total : 0;
  if (ratio > maxVisibleRatio) maxVisibleRatio = ratio;
  lastTotal = stats.total;
  // Cull per-frame line for big grids (2116 cubes x 300 frames = 634800
  // lines is too noisy and floods stdout); keep first 5 + every 50th.
  if (i < 5 || i % 50 === 0) {
    console.log(`[culling] culled=${stats.culled} total=${stats.total} visible=${visible}`);
  }

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

// --- 5. Pixel readback ---

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
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

const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const ndcCenter = readRgba(cx, cy);
const pixelSamples = { ndcCenter };
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 6. Verdict ---

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];
const dist = distance(ndcCenter, BLACK);

// AC-12 / AC-15 post-run grep: count [mesh-ssbo] info lines + check that
// the queue-write-buffer-out-of-bounds string never landed in stdout.
const meshSsboInfoLines = stdoutLines.filter((l) => l.includes('[mesh-ssbo]'));
const writeBufferOobLines = stdoutLines.filter((l) =>
  l.includes('queue-write-buffer-out-of-bounds'),
);
// plan-strategy 2.D-2 culling semantic guard: with GRID_SIZE=46 (2116 cubes)
// and a narrow camera (fov=PI/5, far=30) orbiting at radius 8, frustum
// culling should drop >= 80% of cubes every frame. Threshold = 20% ratio.
const VISIBLE_RATIO_CEILING = 0.20;

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center pixel ${JSON.stringify(ndcCenter)} too close to black (distance ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD})`);
}
if (maxCulled === 0) {
  failures.push('(d) frustum culling never active: maxCulled=0 across all frames');
}
if (errors.length > 0) {
  const firstDetailJson = (() => {
    try { return JSON.stringify(errors[0]?.detail); } catch { return '<unstringifiable>'; }
  })();
  const codeCounts = {};
  for (const e of errors) codeCounts[e.code] = (codeCounts[e.code] ?? 0) + 1;
  const codes = Object.entries(codeCounts).map(([c, n]) => `${c}=${n}`).join(', ');
  failures.push(
    `(e) Renderer.onError fired ${errors.length} times: [${codes}]; first detail=${firstDetailJson}`,
  );
}
if (writeBufferOobLines.length > 0) {
  failures.push(
    `(f) console output contains 'queue-write-buffer-out-of-bounds' (${writeBufferOobLines.length} hit(s)): SSBO grow path failed to keep buffer >= entity count`,
  );
}
if (rhiErrorCount > 0) {
  failures.push(`(g) RhiError fan-out count=${rhiErrorCount} (expected 0 in steady state)`);
}
if (meshSsboEventCount > 0) {
  failures.push(
    `(h) mesh-ssbo-* event count=${meshSsboEventCount} (expected 0; capacity-exceeded / ceiling-reached should not fire under stress)`,
  );
}
if (meshSsboInfoLines.length === 0) {
  failures.push(
    "(i) [mesh-ssbo] info line count=0 (expected >= 1; with GRID_SIZE=46 = 2116 entities the 1024->2048 grow MUST fire on the first frame -- 0 means the grow hook never reached, AC-12 stress unverified)",
  );
}
if (maxVisibleRatio > VISIBLE_RATIO_CEILING) {
  failures.push(
    `(j) culling semantic guard: maxVisible/total=${maxVisibleRatio.toFixed(3)} > ${VISIBLE_RATIO_CEILING} (max ${maxVisible}/${lastTotal}); stress mode broke frustum culling`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-culling smoke`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 10 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${dist.toFixed(4)}, maxCulled=${maxCulled}, RhiError count=0, mesh-ssbo events=0, [mesh-ssbo] info lines=${meshSsboInfoLines.length}, maxVisible/total=${maxVisibleRatio.toFixed(3)} (<=${VISIBLE_RATIO_CEILING})`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);