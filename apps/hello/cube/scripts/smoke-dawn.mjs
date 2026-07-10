#!/usr/bin/env node
// hello-cube headless smoke (M4 / D-S10 / AC-12b).
// feat-20260531-per-frame-bind-group-cache: also asserts AC-03 (stable scene,
// frame-3 bindGroupCounts.createBindGroup == 0).
//
// Strategy (charter proposition 5 consistent abstraction): drive the engine
// ECS path end-to-end, NOT a parallel inline shader implementation.
//
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0; same setup as hello-triangle smoke
//      / vitest.setup-webgpu.ts F-1 / D-P2).
//   2. Build a mock HTMLCanvasElement whose `getContext('webgpu')` returns a
//      shim GPUCanvasContext: `configure({ device, format, usage })` records
//      the texture format and allocates an offscreen render target (800x600
//      BGRA8 unorm + RENDER_ATTACHMENT | COPY_SRC); `getCurrentTexture()`
//      returns that texture each frame.
//   3. Build a World identical to apps/hello/cube/src/main.ts (cube +
//      Camera + DirectionalLight) and call createRenderer + await
//      renderer.ready + 300x renderer.draw(world).
//   4. After the loop, copyTextureToBuffer + mapAsync NDC center sample;
//      verdict = 4 criteria (a) backend=webgpu (b) frames>=300 (c) NDC pixel
//      distance to black > eps (d) Renderer.onError RhiError count == 0.
//
// Output literals (must be preserved byte-for-byte for grep-based tooling):
//   - `[hello-cube] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//
// Note: ECS path drives RenderSystem (D-S2) which records draw commands via
// the @forgeax/engine-rhi surface. If the M2 GPU wiring is incomplete, the smoke
// criteria (c) and/or (d) may FAIL with structured diagnostics on stderr;
// that failure is the architectural truth - no parallel inline-shader
// fallback path is provided here (charter proposition 4 explicit failure).

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// --- ENV knobs (default-aligned with hello-triangle smoke for SSOT consistency) ---

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-cube smoke');
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-cube smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// We need the raw GPUDevice that the engine's createRenderer ends up using
// so the mock canvas (and the post-loop readback) can run on the same device.
// M6 (feat-20260510-rhi-resource-creation / w44): the M4 single-point escape
// hatch (`_internal_getRawDevice`) is gone; capture the raw GPUDevice by
// monkey-patching `navigator.gpu.requestAdapter` so the spec
// `adapter.requestDevice` returns through our hook before the engine's
// internal `rhi.requestDevice` (deprecated single-step wrapper) sees it
// (charter proposition 5 consistent abstraction red line + AC-08 (h) grep
// gate keeps `_internal_getRawDevice` at 0 hits across packages/ + apps/).
//
// feat-20260515-ecs-name-component-and-string-schema M3 / w3-hello-cube-smoke-asserts
// (AC-14): mirror the `apps/hello/cube/src/main.ts` Name spawn/set/despawn
// flow inside this smoke harness (browser-vs-node split — main.ts only runs
// in the browser entry; the smoke harness drives node ESM). The console.log
// lines below are captured via a stdout tap and asserted after the existing
// pixel-readback verdict (criterion (e), additive — does not weaken a..d).
const stdoutLines = [];
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  stdoutLines.push(line);
  originalConsoleLog(...args);
};

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
  // RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01)
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
          // configure not yet called - allocate with default bgra8unorm so
          // the engine can record a clear pass even before context.configure
          // (the M2 placeholder path on the WebGPU branch).
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

// --- 3. Drive engine ECS path ------------------------------------------------

// Workspace imports resolve via package.json; dist build outputs are
// consumed directly (no Vite middleware). We import after the GPU shim is
// installed so the engine sees navigator.gpu.
const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { Name } = enginePkg;
const {
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
const world = new World();
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  {
    component: MeshRenderer,
    data: {},
  },
);
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

// feat-20260515-ecs-name-component-and-string-schema M3 / w3-hello-cube-smoke-asserts
// (AC-14): canonical Name + 'string' schema vocab end-to-end exemplar mirrored
// from apps/hello/cube/src/main.ts (the browser entry main.ts cannot run in
// node-dawn; this block is the smoke-harness twin so the same console.log
// triple is observable here for the (e) criterion assertion below).
{
  const player = world.spawn({ component: Name, data: { value: 'Player' } }).unwrap();
  const initialName = world.get(player, Name).unwrap().value;
  console.log(`[hello-cube] Name=${initialName}`);
  world.set(player, Name, { value: 'Boss' }).unwrap();
  const mutatedName = world.get(player, Name).unwrap().value;
  console.log(`[hello-cube] Name=${mutatedName}`);
  world.despawn(player).unwrap();
  console.log('[hello-cube] Name despawned, slot freed');
}

// feat-20260518-pbr-direct-lighting-mvp M5 / w22.9: build a real manifest
// from the engine's shipped pbr/unlit WGSL via @forgeax/engine-vite-plugin-shader's
// buildEngineShaderManifest helper (same composition path the plugin emits
// at vite build time, charter P5 — the runtime no longer ships an inline
// fallback shader so the manifest must carry both entries).
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {
        // M6 / w44: rawDeviceForContextConfigure is no longer required because
    // the forgeax RhiCanvasContext.configure resolves the RhiDevice back to
    // the raw GPUDevice via RAW_DEVICE_MAP internally (charter proposition
    // 5; see packages/engine/src/createRenderer.ts ensureContextConfigured).
  }, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  // Restore the original ambient requestAdapter; the navigator.gpu wrap was
  // installed solely to capture sharedDevice during the engine's first
  // adapter.requestDevice call.
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[hello-cube] backend=${renderer.backend}`);

// Accumulate Renderer.onError fires for criterion (d).
const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

// w25 — Renderer.ready resolves Result<void, RhiError>; branch on `.ok`.
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// 300-frame loop; raf is unavailable in node so we drive sync calls.
const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
// feat-20260531-per-frame-bind-group-cache M5 / w17: AC-03 counter
// accumulator — snapshot createBindGroupCount on the first few frames
// and assert it reaches 0 on frame 3 (warm cache). The smoke gate
// already exercises the real dawn-node GPU path; a counter mismatch here
// signals a real cache-miss regression (AC-02 gate).
let bindGroupCountFrame3;

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  // w25 — draw returns Result; errors continue to fan out through onError.
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;

  // Snapshot counter on frame 3 (1-indexed). The Renderer interface
  // exposes bindGroupCounts as a readonly getter; the counter is reset
  // on every draw(world) entry and bumped on each cache-miss.
  if (framesObserved === 3) {
    bindGroupCountFrame3 = renderer.bindGroupCounts.createBindGroup;
  }
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 4. Pixel readback (NDC center sample) ----------------------------------

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
const corner = readRgba(Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
const pixelSamples = { ndcCenter, corner };
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (four criteria) ---------------------------------------------

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];
const dist = distance(ndcCenter, BLACK);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center pixel ${JSON.stringify(ndcCenter)} too close to black (distance ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD})`);
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (e) feat-20260515 M3 / w3-hello-cube-smoke-asserts (AC-14): assert the
// Name spawn/set/despawn console.log triple appears in stdout. The Name
// flow runs before the GPU pipeline so its output is independent of the
// pixel-readback verdict — this criterion does not weaken (a)..(d).
const REQUIRED_NAME_LINES = [
  '[hello-cube] Name=Player',
  '[hello-cube] Name=Boss',
  '[hello-cube] Name despawned, slot freed',
];
const missingNameLines = REQUIRED_NAME_LINES.filter((expected) =>
  !stdoutLines.some((line) => line.includes(expected)),
);
if (missingNameLines.length > 0) {
  failures.push(
    `(e) Name spawn/set/despawn console.log triple missing ${missingNameLines.length} of 3 lines: ${JSON.stringify(missingNameLines)}`,
  );
}

// AC-03 (feat-20260531-per-frame-bind-group-cache M5 / w17): assert
// stable-frame createBindGroupCount == 0 on frame 3 after cache warm-up.
// This is a correctness + performance gate — non-zero signals a cache
// miss regression or an unhandled createBindGroup call site.
if (bindGroupCountFrame3 !== undefined) {
  console.log(`[smoke] bindGroupCounts.createBindGroup frame-3=${bindGroupCountFrame3}`);
  if (bindGroupCountFrame3 !== 0) {
    failures.push(
      `(f) AC-03 bind-group-cache: createBindGroupCount on frame 3 = ${bindGroupCountFrame3} (expected 0 — cache miss regression)`,
    );
  }
} else {
  failures.push('(f) AC-03 bind-group-cache: frame-3 counter not captured (smoke loop too short)');
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-cube smoke`);
  console.error('  hint:  inspect Renderer.onError fan-out + verify @forgeax/engine-runtime ECS path GPU wiring on dawn-node');
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${dist.toFixed(4)}, RhiError count=0, Name spawn/set/despawn 3-line trace observed, bind-group-cache frame-3 counter = ${bindGroupCountFrame3}`);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
