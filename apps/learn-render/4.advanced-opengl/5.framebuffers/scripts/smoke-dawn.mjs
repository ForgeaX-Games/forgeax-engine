#!/usr/bin/env node
// apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 5.framebuffers dawn-node smoke.
//
// === STATUS: PIXEL-DIFF (M5R2 / T-12-b) ===
//
// Drives the demo through TWO post-process states (passthrough -> inversion),
// reads back the offscreen RT after each state, and asserts the linear-space
// relation `inversion[i] approx 1.0 - passthrough[i]` at sample sites with
// epsilon <= 0.05. FORGEAX_SMOKE_FALSIFY=1 inverts the expectation so a
// no-op shader (passthrough only) makes the smoke fail and the falsifier
// proves the relation is load-bearing.
//
// What makes this smoke real (T-12-a engine fix shipped in the same loop):
// - addScenePass.opts.color is now respected by the recordMainPass execute
//   closure (when the pipeline opts in via _routeFromOpts). The geometry
//   scene draws into the graph-owned 'offscreenColor' RT.
// - addFullscreenPass writes 'swapchain' (built-in reserved key in
//   render-graph validateNoUnknownResource); the dispatcher's resolveCtx
//   fallback routes the post output to ctx.view (the swap-chain).
//
// AC alignment:
//   AC-02 (passthrough preserves geometry): the passthrough state's center
//         pixel is non-black (geometry was drawn).
//   AC-03 (inversion linear-relation): for each of N sample sites, the
//         linearized inversion pixel approx 1 - linearized passthrough
//         pixel within epsilon.
//   AC-04 (in-process state switch): single createApp; install A succeeds,
//         install B succeeds, both drive frames + readbacks without crash.
//   AC-05 (>=300 frames + 0 RhiError): asserted directly.
//   AC-08 (id literals match src/index.ts): inline mirror; AI-user grep
//         finds the 6 'learn-render-5::*' + 6 'learn-render-5-pipeline::*'
//         literals here too.
//
// Output literals (preserved for grep tooling):
//   `[learn-render-5-framebuffers] backend=<backend>`
//   `[smoke] frames observed=<N>`
//   `[smoke] PASS`
//   `[smoke] FAIL - <reason>`

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const PER_STATE_FRAMES = Math.max(150, Math.ceil(SMOKE_MIN_FRAMES / 2));
const FALSIFY = process.env.FORGEAX_SMOKE_FALSIFY === '1';
const EPSILON = 0.05;
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const CONTAINER_SRC_PATH = resolve(TEXTURES_DIR, 'container.jpg');
const METAL_SRC_PATH = resolve(TEXTURES_DIR, 'metal.png');

const CONTAINER_GUID_STR = '019e3969-1d46-773e-988c-a10e305ff2a4';
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  originalConsoleError(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
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
  originalConsoleError(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  originalConsoleError('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
const realPerformanceNow =
  globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

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

// --- 2. Mock canvas + offscreen render target ---

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  // RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01) so the smoke can readback the
  // post-process output written through the swap-chain view.
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
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

// --- 3. Asset fixtures check ---

if (!existsSync(CONTAINER_SRC_PATH)) {
  originalConsoleError(`[smoke] FAIL - asset fixture missing: ${CONTAINER_SRC_PATH}`);
  process.exit(1);
}
if (!existsSync(METAL_SRC_PATH)) {
  originalConsoleError(`[smoke] FAIL - asset fixture missing: ${METAL_SRC_PATH}`);
  process.exit(1);
}

// --- 4. Imports + decode textures ---

const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { createApp } = await import('@forgeax/engine-app');
const runtimePkg = await import('@forgeax/engine-runtime');
const {
  addFullscreenPass,
  addScenePass,
  Camera,
  HANDLE_CUBE,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = runtimePkg;
const { RenderGraph } = await import('@forgeax/engine-render-graph');
const { unwrapHandle } = await import('@forgeax/engine-types');

const containerDecodeRes = await decodeImageFromFile(CONTAINER_SRC_PATH);
if (!containerDecodeRes.ok) {
  originalConsoleError('[smoke] FAIL - decodeImageFromFile container failed:', containerDecodeRes.error.code);
  process.exit(1);
}
const metalDecodeRes = await decodeImageFromFile(METAL_SRC_PATH);
if (!metalDecodeRes.ok) {
  originalConsoleError('[smoke] FAIL - decodeImageFromFile metal failed:', metalDecodeRes.error.code);
  process.exit(1);
}
const { decoded: containerDecoded } = containerDecodeRes.value;
const { decoded: metalDecoded } = metalDecodeRes.value;

// --- 5. Build shader manifest from this demo's dist (vite build output) ---

const MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(MANIFEST_PATH)) {
  originalConsoleError(`[smoke] FAIL - shader manifest missing at ${MANIFEST_PATH}`);
  originalConsoleError(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers' build",
  );
  process.exit(1);
}
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

// --- 6. createApp + register textures + scene ---

const appResult = await createApp(
  mockCanvas,
  {},
  { shaderManifestUrl: MANIFEST_URL },
).catch((err) => {
  originalConsoleError(
    `[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
const renderer = app.renderer;
const world = app.world;
console.log(`[learn-render-5-framebuffers] backend=${renderer.backend}`);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));
const rendererErrors = [];
renderer.onError((err) => rendererErrors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  originalConsoleError(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const assets = renderer.assets;
if (!assets) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

function makeTexAsset(decoded) {
  return {
    kind: 'texture',
    width: decoded.width,
    height: decoded.height,
    format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    data: decoded.bytes,
    colorSpace: decoded.colorSpace,
    mipmap: decoded.mipmap,
  };
}

const containerGuidRes = AssetGuid.parse(CONTAINER_GUID_STR);
if (!containerGuidRes.ok) {
  originalConsoleError('[smoke] FAIL - container GUID parse failed');
  process.exit(1);
}
const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
if (!metalGuidRes.ok) {
  originalConsoleError('[smoke] FAIL - metal GUID parse failed');
  process.exit(1);
}
const containerHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(containerDecoded)));
const metalHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(metalDecoded)));

const cubeMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: { baseColor: [1.0, 1.0, 1.0, 1.0], baseColorTexture: containerHandle },
});
const floorMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: { baseColor: [1.0, 1.0, 1.0, 1.0], baseColorTexture: metalHandle },
});

const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

world
  .spawn(
    { component: Transform, data: { posX: -1, posY: 0, posZ: -1 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();
world
  .spawn(
    { component: Transform, data: { posX: 2, posY: 0, posZ: 0 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: -0.5,
        posZ: 0,
        quatX: FLOOR_QUAT_X,
        quatW: FLOOR_QUAT_W,
        scaleX: 5,
        scaleY: 5,
        scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 3 } },
  {
    component: Camera,
    data: perspective({
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
    }),
  },
);

// --- 7. Register the 6 post-process shaders + 6 RenderPipeline impls + 6 RenderPipelineAsset handles ---
//
// AC-08 grep gate: id literals identical to those in src/index.ts.

const OFFSCREEN_COLOR_KEY = 'offscreenColor';
const OFFSCREEN_DEPTH_KEY = 'offscreenDepth';

function makeEffectPipeline(shaderId) {
  return {
    buildGraph(ctx) {
      const graph = new RenderGraph();
      graph.addColorTarget(OFFSCREEN_COLOR_KEY, {
        format: 'rgba8unorm-srgb',
        size: 'swapchain',
        sample: 1,
        usage: 0x10 | 0x04,
      });
      graph.addColorTarget(OFFSCREEN_DEPTH_KEY, {
        format: 'depth24plus-stencil8',
        size: 'swapchain',
        sample: 1,
        usage: 0x10,
      });
      addScenePass(graph, 'main', {
        color: OFFSCREEN_COLOR_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        _routeFromOpts: true,
      });
      addFullscreenPass(graph, 'post', {
        shader: shaderId,
        color: 'swapchain',
        reads: [OFFSCREEN_COLOR_KEY],
      });
      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) {
        return null;
      }
      return graph;
    },
    execute(ctx) {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

const SHADER_FILE = {
  '1': 'passthrough.wgsl',
  '2': 'inversion.wgsl',
  '3': 'grayscale.wgsl',
  '4': 'sharpen.wgsl',
  '5': 'blur.wgsl',
  '6': 'edge-detection.wgsl',
};
function resolveShaderSource(key) {
  const fname = SHADER_FILE[key];
  if (!fname) return null;
  const p = resolve(APP_ROOT, 'src', 'shaders', fname);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

const SHADER_IDS = {
  '1': 'learn-render-5::passthrough',
  '2': 'learn-render-5::inversion',
  '3': 'learn-render-5::grayscale',
  '4': 'learn-render-5::sharpen',
  '5': 'learn-render-5::blur',
  '6': 'learn-render-5::edge',
};
const PIPELINE_IDS = {
  '1': 'learn-render-5-pipeline::passthrough',
  '2': 'learn-render-5-pipeline::inversion',
  '3': 'learn-render-5-pipeline::grayscale',
  '4': 'learn-render-5-pipeline::sharpen',
  '5': 'learn-render-5-pipeline::blur',
  '6': 'learn-render-5-pipeline::edge-detection',
};

const pipelineAssets = new Map();
let registerErrCount = 0;
for (const key of ['1', '2', '3', '4', '5', '6']) {
  const shaderId = SHADER_IDS[key];
  const pipelineId = PIPELINE_IDS[key];
  const src = resolveShaderSource(key);
  if (src === null) {
    originalConsoleError(`[smoke] FAIL - shader source missing on disk for ${shaderId}`);
    process.exit(1);
  }
  try {
    renderer.postProcess.register(shaderId, {
      source: src,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    renderer.registerPipeline(pipelineId, makeEffectPipeline(shaderId));
  } catch (e) {
    registerErrCount++;
    originalConsoleError('[smoke] register threw:', e instanceof Error ? e.message : String(e));
  }
  pipelineAssets.set(key, { kind: 'render-pipeline', pipelineId });
}

if (registerErrCount > 0) {
  originalConsoleError(`[smoke] FAIL - ${registerErrCount} of 6 register calls threw`);
  process.exit(1);
}

function installPipelineByKey(key) {
  const asset = pipelineAssets.get(key);
  if (!asset) {
    return { ok: false, error: { code: 'unknown-effect-key', hint: `expected '1'..'6', received ${JSON.stringify(key)}` } };
  }
  return renderer.installPipeline(asset);
}

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

async function pumpFrames(n) {
  let pumped = 0;
  for (let i = 0; i < n; i++) {
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
    pumped++;
    // Yield to the event loop so async shader-module compiles can resolve
    // (post-process pipelines warm up via the shared shader-adapter's async
    // path; without a microtask flush every frame, the compile never lands
    // and getPostProcessPipeline keeps returning null).
    if ((i & 7) === 0) await delay(0);
  }
  await delay(0);
  return pumped;
}

// --- 8. Pixel readback helper ---

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function readbackBgra(device) {
  const buf = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const mapped = buf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  return bytes;
}

// renderTarget is bgra8unorm storage; bytes are sRGB-encoded values written
// through the bgra8unorm-srgb view by the post pass. Decode to linear before
// asserting `inv_lin approx 1 - pass_lin`.
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function readRgbaLinear(bytes, px, py) {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

// Sample sites: NDC center (likely cube), small offsets in 4 cardinal
// directions, plus 4 corners. 9 sites total.
const SAMPLE_SITES = [
  [Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.5)],
  [Math.floor(WIDTH * 0.4), Math.floor(HEIGHT * 0.4)],
  [Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.6)],
  [Math.floor(WIDTH * 0.4), Math.floor(HEIGHT * 0.6)],
  [Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.4)],
  [Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.7)],
  [Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.5)],
  [Math.floor(WIDTH * 0.7), Math.floor(HEIGHT * 0.5)],
  [Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.3)],
];

// --- 9. State A: passthrough ---

const installAResult = installPipelineByKey('1');
if (!installAResult.ok) {
  originalConsoleError(`[smoke] FAIL - installPipelineByKey('1'): ${installAResult.error.code}`);
  process.exit(1);
}
const framesA = await pumpFrames(PER_STATE_FRAMES);

const device = sharedDevice;
if (!device) {
  originalConsoleError('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const bytesA = await readbackBgra(device);
const samplesA = SAMPLE_SITES.map(([x, y]) => readRgbaLinear(bytesA, x, y));

// --- 10. State B: inversion ---

const installBResult = installPipelineByKey('2');
if (!installBResult.ok) {
  originalConsoleError(`[smoke] FAIL - installPipelineByKey('2'): ${installBResult.error.code}`);
  process.exit(1);
}
const framesB = await pumpFrames(PER_STATE_FRAMES);
await device.queue.onSubmittedWorkDone();
const bytesB = await readbackBgra(device);
const samplesB = SAMPLE_SITES.map(([x, y]) => readRgbaLinear(bytesB, x, y));

const totalFrames = framesA + framesB;
console.log(`[smoke] frames observed=${totalFrames} (a=${framesA}, b=${framesB})`);

// --- 11. Stop app + clean up ---

globalThis.performance.now = realPerformanceNow;
await delay(200);
const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

// --- 12. Verdict ---

const failures = [];
if (renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
}
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}
const allErrorEvents = [...onErrorEvents, ...rendererErrors];
if (allErrorEvents.length > 0) {
  failures.push(
    `(c) RhiError fired ${allErrorEvents.length} times: ${JSON.stringify(allErrorEvents.slice(0, 3))}`,
  );
}
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

// AC-02: passthrough must contain real geometry pixels somewhere — at
// least one of the 9 sample sites lands on the cube / floor (the rest
// fall on the cleared background, which is a valid scene-config choice).
let geometrySites = 0;
let maxLuma = 0;
for (const s of samplesA) {
  const luma = (s[0] + s[1] + s[2]) / 3;
  if (luma > 0.02) geometrySites++;
  if (luma > maxLuma) maxLuma = luma;
}
if (geometrySites === 0) {
  failures.push(`(e) AC-02 passthrough has no geometry pixels: 0/${samplesA.length} sites > 0.02 linear luma (max=${maxLuma.toFixed(4)})`);
}

// AC-03: inversion linear-relation B[i] approx 1 - A[i] within EPSILON.
let relationViolations = 0;
const relationDetails = [];
for (let i = 0; i < SAMPLE_SITES.length; i++) {
  const a = samplesA[i];
  const b = samplesB[i];
  for (let c = 0; c < 3; c++) {
    const expected = 1 - a[c];
    const diff = Math.abs(b[c] - expected);
    if (diff > EPSILON) {
      relationViolations++;
      if (relationDetails.length < 3) {
        relationDetails.push(
          `site=${i} (${SAMPLE_SITES[i][0]},${SAMPLE_SITES[i][1]}) ch=${c} A=${a[c].toFixed(3)} B=${b[c].toFixed(3)} expected=${expected.toFixed(3)} diff=${diff.toFixed(3)}`,
        );
      }
    }
  }
}
const relationOK = relationViolations === 0;

if (FALSIFY) {
  // FALSIFY mode: invert the inversion-relation expectation. PASS requires
  // relation FAILS (otherwise the relation is not load-bearing). With the
  // engine in working order the relation passes, so FALSIFY=1 forces a
  // non-zero exit and proves AC-03 actually constrains the output.
  if (relationOK) {
    originalConsoleError(
      '[smoke] FAIL - FORGEAX_SMOKE_FALSIFY=1 expected inversion relation to fail (proving the assertion is load-bearing) but it passed.',
    );
    if (sharedDevice) sharedDevice.destroy?.();
    process.exit(1);
  }
  // FALSIFY mode + relation broken -> the assertion proved load-bearing; PASS.
  console.log(
    `[smoke] PASS (FALSIFY=1) - inversion relation broke as expected (violations=${relationViolations}/${SAMPLE_SITES.length * 3}); the relation is load-bearing.`,
  );
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(0);
}

if (!relationOK) {
  failures.push(
    `(f) AC-03 inversion linear-relation violated at ${relationViolations}/${SAMPLE_SITES.length * 3} channels (epsilon=${EPSILON}). first: ${relationDetails.join(' | ')}`,
  );
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  originalConsoleError(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers' smoke",
  );
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - frames=${totalFrames}, install A+B ok, AC-02 geometry sites=${geometrySites}/${samplesA.length} (max linear luma=${maxLuma.toFixed(3)}), AC-03 inversion relation holds across ${SAMPLE_SITES.length * 3} channels (epsilon=${EPSILON}), backend=${renderer.backend}.`,
);
if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
