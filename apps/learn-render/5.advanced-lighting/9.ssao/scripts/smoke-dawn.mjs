#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/9.ssao/scripts/smoke-dawn.mjs
// feat-20260612-hdrp-ssao M5 w22 (structural-only) + M9 w40/w41 (discrimination).
//
// LearnOpenGL section 5.9 SSAO dawn-node smoke.
// Normal mode: spawns cube+sphere+floor through HDRP deferred opaque with SSAO
// enabled, renders 300 frames, asserts perFramePassNames includes ssao-calc +
// ssao-blur (structural-only).
//
// --discrimination mode (M9 w40/w41): renders 2 passes — normal SSAO vs
// FALSIFY=ssao-wrong-input — reads back center 32x32 R-channel mean from each,
// asserts |mean_normal - mean_wrong| >= 0.05 (visual discrimination gate,
// plan-strategy D-F / section 5.4).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-9-ssao] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke-discrimination] mean.normal=<N> mean.wrong=<N> diff=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const DISCRIMINATION = process.argv.includes('--discrimination');
const WIDTH = 512;
const HEIGHT = 512;

const SSAO_CONFIG = {
  enabled: true,
  radius: 0.5,
  bias: 0.025,
  intensity: 1.0,
};

const FLOOR_Y = -1.0;
const FLOOR_SCALE_XZ = 5.0;
const FLOOR_SCALE_Y = 0.1;
const CUBE_Y = -0.5;
const SPHERE_Y = -0.2;
const OBJECT_X_OFFSET = 1.2;

const here = dirname(fileURLToPath(import.meta.url));

// --- dawn.node binding setup (shared by both normal + discrimination) ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
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
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- engine shader manifest (shared by both paths) ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// ── M9 w41 GREEN: --discrimination dual-render + readback ─────────────────

if (DISCRIMINATION) {
  // ── M9 w41 GREEN: dual-render discrimination ───────────────────────────

  let readbackDevice;

  // Re-capture the adapter interception for readback passthrough.
  // sharedDevice is set by the first createApp call inside the adapter hook.
  // We use a fresh rafQueue per pass.

  // --- Helper: create a fresh mock canvas for each pass ---

  function makeMockCanvas(readbackTargetRef) {
    return {
      tagName: 'CANVAS',
      isConnected: true,
      width: WIDTH,
      height: HEIGHT,
      getContext(kind) {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc) {
            const rt = desc.device.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: desc.format ?? 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
            // eslint-disable-next-line no-param-reassign
            readbackTargetRef.tex = rt;
          },
          unconfigure() {},
          getCurrentTexture() {
            return readbackTargetRef.tex;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  // --- Helper: read center 32x32 R-channel mean from a render target ---

  async function readCenterRMean(device, texture, label) {
    const CENTER = 32;
    const halfW = WIDTH >> 1;
    const halfH = HEIGHT >> 1;
    const halfC = CENTER >> 1;
    const x = halfW - halfC;
    const y = halfH - halfC;
    // bytesPerRow must be a multiple of 256 in WebGPU.
    const alignedRowBytes = 256;
    const totalBytes = CENTER * alignedRowBytes;
    const buf = device.createBuffer({
      size: totalBytes,
      usage: 0x01 | 0x08, // MAP_READ | COPY_DST
      label: `ssao-readback-${label}`,
    });
    const encoder = device.createCommandEncoder({ label: `ssao-copy-${label}` });
    encoder.copyTextureToBuffer(
      { texture, mipLevel: 0, origin: { x, y, z: 0 } },
      { buffer: buf, bytesPerRow: alignedRowBytes, rowsPerImage: CENTER },
      { width: CENTER, height: CENTER, depthOrArrayLayers: 1 },
    );
    const cmd = encoder.finish();
    device.queue.submit([cmd]);
    await device.queue.onSubmittedWorkDone();
    await buf.mapAsync(1); // GPUMapMode.READ
    const pixelRowBytes = CENTER * 4;
    const mapped = new Uint8Array(buf.getMappedRange());
    let sum = 0;
    for (let row = 0; row < CENTER; row++) {
      const base = row * alignedRowBytes;
      for (let col = 0; col < pixelRowBytes; col += 4) {
        sum += mapped[base + col]; // R channel
      }
    }
    const pixelCount = CENTER * CENTER;
    const mean = sum / (pixelCount * 255);
    buf.unmap();
    buf.destroy();
    return mean;
  }

  // --- Helper: run one smoke pass with the given SSAO config + return R mean ---

  async function runDiscriminationPass(ssaoConfig, label) {
    const rafQueue = [];
    let rafCounter = 1;
    globalThis.requestAnimationFrame = (cb) => {
      const id = rafCounter++;
      rafQueue.push({ id, cb });
      return id;
    };

    const readbackRef = { tex: null };
    const canvas = makeMockCanvas(readbackRef);

    let sharedDeviceLocal;
    const originalReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const adapter = await originalReqAdapter(opts);
      if (adapter === null) return adapter;
      const originalReqDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (desc) => {
        const dev = await originalReqDevice(desc);
        if (!sharedDeviceLocal) sharedDeviceLocal = dev;
        return dev;
      };
      return adapter;
    };

    const { createApp: createAppLocal } = await import('@forgeax/engine-app');
    const runtimePkgLocal = await import('@forgeax/engine-runtime');
    const {
      Camera: CameraLocal,
      DirectionalLight: DirectionalLightLocal,
      HANDLE_CUBE: HANDLE_CUBE_LOCAL,
      HANDLE_SPHERE: HANDLE_SPHERE_LOCAL,
      HDRP_PIPELINE_ID: HDRP_PIPELINE_ID_LOCAL,
      Materials: MaterialsLocal,
      MeshFilter: MeshFilterLocal,
      MeshRenderer: MeshRendererLocal,
      perspective: perspectiveLocal,
      Transform: TransformLocal,
    } = runtimePkgLocal;

    const appResult = await createAppLocal(canvas, {}, { shaderManifestUrl: MANIFEST_URL });
    globalThis.navigator.gpu.requestAdapter = originalReqAdapter;

    if (!appResult.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - createApp error: ${appResult.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }
    const app = appResult.value;
    if (!readbackDevice) readbackDevice = sharedDeviceLocal;

    const onErrorEvents = [];
    app.onError((err) => onErrorEvents.push({ code: err.code }));

    const ready = await app.renderer.ready;
    if (!ready.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - renderer.ready: ${ready.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }

    const assets = app.renderer.assets;
    if (assets === null) {
      console.error(`[smoke-discrimination] FAIL pass=${label} - AssetRegistry null`);
      return { mean: null, device: sharedDeviceLocal };
    }

    // feat-20260614 M8 (D-19): installPipeline takes the RenderPipelineAsset
    // POD directly (no register round-trip; AssetRegistry holds no handle).
    const installRes = app.renderer.installPipeline({
      kind: 'render-pipeline',
      pipelineId: HDRP_PIPELINE_ID_LOCAL,
      config: { ssao: ssaoConfig },
    });
    if (!installRes.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - installPipeline: ${installRes.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }

    const world = app.world;

    // Spawn scene. feat-20260614 M8 (D-17): mint user-tier column handles via
    // world.allocSharedRef (bare Handle, not a Result).
    const floorMatHandle = world.allocSharedRef('MaterialAsset', MaterialsLocal.standard({ baseColor: [0.6, 0.6, 0.6, 1] }));
    const cubeMatHandle = world.allocSharedRef('MaterialAsset', MaterialsLocal.standard({ baseColor: [0.9, 0.35, 0.2, 1] }));
    const sphereMatHandle = world.allocSharedRef('MaterialAsset', MaterialsLocal.standard({ baseColor: [0.2, 0.45, 0.9, 1] }));

    world.spawn(
      { component: TransformLocal, data: { posX: 0, posY: FLOOR_Y, posZ: 0, quatW: 1, scaleX: FLOOR_SCALE_XZ, scaleY: FLOOR_SCALE_Y, scaleZ: FLOOR_SCALE_XZ } },
      { component: MeshFilterLocal, data: { assetHandle: HANDLE_CUBE_LOCAL } },
      { component: MeshRendererLocal, data: { materials: [floorMatHandle] } },
    ).unwrap();
    world.spawn(
      { component: TransformLocal, data: { posX: -OBJECT_X_OFFSET, posY: CUBE_Y, posZ: 0, quatW: 1, scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7 } },
      { component: MeshFilterLocal, data: { assetHandle: HANDLE_CUBE_LOCAL } },
      { component: MeshRendererLocal, data: { materials: [cubeMatHandle] } },
    ).unwrap();
    world.spawn(
      { component: TransformLocal, data: { posX: OBJECT_X_OFFSET, posY: SPHERE_Y, posZ: 0, quatW: 1, scaleX: 0.6, scaleY: 0.6, scaleZ: 0.6 } },
      { component: MeshFilterLocal, data: { assetHandle: HANDLE_SPHERE_LOCAL } },
      { component: MeshRendererLocal, data: { materials: [sphereMatHandle] } },
    ).unwrap();
    world.spawn(
      { component: TransformLocal, data: { posX: 1, posY: 2, posZ: 1, quatW: 1 } },
      { component: DirectionalLightLocal, data: { colorR: 1.0, colorG: 0.95, colorB: 0.85, intensity: 0.6 } },
    );
    world.spawn(
      { component: TransformLocal, data: { posX: 0, posY: 1.8, posZ: 4.5, quatW: 1 } },
      { component: CameraLocal, data: { ...perspectiveLocal({ fov: Math.PI / 3.5, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }), clearR: 0.02, clearG: 0.02, clearB: 0.04 } },
    ).unwrap();

    // Render frames.
    let fakeNow = 0;
    globalThis.performance.now = () => fakeNow;
    const startResult = app.start();
    if (!startResult.ok) {
      console.error(`[smoke-discrimination] FAIL pass=${label} - app.start: ${startResult.error.code}`);
      return { mean: null, device: sharedDeviceLocal };
    }

    const isWrong = ssaoConfig.bias < 0;
    const frameCount = isWrong ? 60 : SMOKE_MIN_FRAMES;
    let totalFrames = 0;
    for (let i = 0; i < frameCount; i++) {
      const due = rafQueue.shift();
      if (!due) break;
      fakeNow += 16.67;
      due.cb(fakeNow);
      totalFrames++;
      if (i % 16 === 15) await delay(1);
    }

    app.stop();
    if (!readbackRef.tex || !sharedDeviceLocal) {
      console.error(`[smoke-discrimination] FAIL pass=${label} - no render target`);
      return { mean: null, device: sharedDeviceLocal };
    }

    await sharedDeviceLocal.queue.onSubmittedWorkDone();
    const mean = await readCenterRMean(sharedDeviceLocal, readbackRef.tex, label);

    // Destroy the app's device textures to avoid leaking.
    readbackRef.tex.destroy?.();
    app.renderer.dispose?.();

    return { mean, device: sharedDeviceLocal, onErrorEvents };
  }

  // --- Execute both passes ---

  console.log('[smoke-discrimination] pass 1/2: normal SSAO');
  const normalResult = await runDiscriminationPass({ ...SSAO_CONFIG }, 'normal');
  if (normalResult.mean === null) {
    console.error('[smoke-discrimination] FAIL - normal pass failed');
    if (normalResult.device) normalResult.device.destroy?.();
    process.exit(1);
  }

  console.log('[smoke-discrimination] pass 2/2: wrong-input SSAO (bias=-1.0)');
  const wrongResult = await runDiscriminationPass({ ...SSAO_CONFIG, bias: -1.0 }, 'wrong');
  if (wrongResult.mean === null) {
    console.error('[smoke-discrimination] FAIL - wrong-input pass failed');
    if (wrongResult.device) wrongResult.device.destroy?.();
    process.exit(1);
  }

  const diff = Math.abs(normalResult.mean - wrongResult.mean);
  console.log(
    `[smoke-discrimination] mean.normal=${normalResult.mean.toFixed(4)} mean.wrong=${wrongResult.mean.toFixed(4)} diff=${diff.toFixed(4)}`,
  );

  if (diff < 0.05) {
    console.error(
      `[smoke-discrimination] FAIL - visual discrimination diff=${diff.toFixed(4)} < 0.05 ` +
        `(mean.normal=${normalResult.mean.toFixed(4)} mean.wrong=${wrongResult.mean.toFixed(4)}). ` +
        'SSAO is not producing a visually distinguishable difference when bias=-1.0.',
    );
    if (readbackDevice) readbackDevice.destroy?.();
    process.exit(1);
  }

  console.log(
    `[smoke-discrimination] PASS - visual discrimination GREEN: diff=${diff.toFixed(4)} >= 0.05`,
  );
  if (readbackDevice) readbackDevice.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(0);
}

// Known-noise app.onError codes during HDRP SSAO demo.
const KNOWN_NOISE_CODES = new Set([
  'hdrp-light-budget-exceeded',
  'hdrp-index-list-overflow',
]);

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// rAF / cAF stubs must be installed BEFORE createApp.
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

// --- Mock canvas with offscreen render target ---

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

// --- createApp + setup (normal mode, non-discrimination) ---

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const runtimePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  DirectionalLight,
  HANDLE_CUBE,
  HANDLE_SPHERE,
  HDRP_PIPELINE_ID,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} = runtimePkg;

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-9-ssao] backend=${app.renderer.backend}`);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));

const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const assets = app.renderer.assets;
if (assets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// Register HDRP. Two falsification modes:
//   FALSIFY=ssao-off          -> ssao.enabled=false; smoke asserts zero ssao-* passes
//   FALSIFY=ssao-wrong-input  -> ssao.bias=-1.0; smoke asserts ssao-bias-negative
//                                fires through the runtime onError channel
//                                (per Round-2 [F-4]: validates the parameter
//                                validation path is actually wired, not stubbed).
const ssaoEnabled = FALSIFY !== 'ssao-off';
const ssaoWrongInput = FALSIFY === 'ssao-wrong-input';
// feat-20260614 M8 (D-19): installPipeline takes the RenderPipelineAsset POD
// directly (no register round-trip; AssetRegistry holds no handle concept).
const installRes = app.renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: HDRP_PIPELINE_ID,
  config: {
    ssao: ssaoEnabled
      ? ssaoWrongInput
        ? { ...SSAO_CONFIG, bias: -1.0 }
        : { ...SSAO_CONFIG }
      : { enabled: false },
  },
});
if (!installRes.ok) {
  console.error(`[smoke] FAIL - installPipeline: ${installRes.error.code} - ${installRes.error.hint}`);
  process.exit(1);
}

const world = app.world;

// --- 5. Spawn scene ---

// Floor. feat-20260614 M8 (D-17): mint a user-tier column handle directly via
// world.allocSharedRef (returns a bare Handle, not a Result).
const floorMatHandle = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1] }));

world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: FLOOR_Y, posZ: 0, quatW: 1,
      scaleX: FLOOR_SCALE_XZ, scaleY: FLOOR_SCALE_Y, scaleZ: FLOOR_SCALE_XZ,
    },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [floorMatHandle] } },
).unwrap();

// Cube.
const cubeMatHandle = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.9, 0.35, 0.2, 1] }));
world.spawn(
  {
    component: Transform,
    data: {
      posX: -OBJECT_X_OFFSET, posY: CUBE_Y, posZ: 0, quatW: 1,
      scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7,
    },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
).unwrap();

// Sphere.
const sphereMatHandle = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.2, 0.45, 0.9, 1] }));
world.spawn(
  {
    component: Transform,
    data: {
      posX: OBJECT_X_OFFSET, posY: SPHERE_Y, posZ: 0, quatW: 1,
      scaleX: 0.6, scaleY: 0.6, scaleZ: 0.6,
    },
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [sphereMatHandle] } },
).unwrap();

// Directional light.
world.spawn(
  {
    component: Transform,
    data: { posX: 1, posY: 2, posZ: 1, quatW: 1 },
  },
  {
    component: DirectionalLight,
    data: { colorR: 1.0, colorG: 0.95, colorB: 0.85, intensity: 0.6 },
  },
);

// Camera.
world.spawn(
  {
    component: Transform,
    data: { posX: 0, posY: 1.8, posZ: 4.5, quatW: 1 },
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 3.5, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearR: 0.02,
      clearG: 0.02,
      clearB: 0.04,
    },
  },
).unwrap();

// --- 6. Render 300 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  if (i % 16 === 15) await delay(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);

// Capture perFramePassNames BEFORE stop() clears perFrameGraph.
const perFramePassNames = [...app.renderer.perFramePassNames];
console.log(`[smoke] perFramePassNames=${JSON.stringify(perFramePassNames)}`);
const passNames = new Set(perFramePassNames);

const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

// --- 7. Verdict (structural-only) ---

const failures = [];
if (app.renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.backend} (expected webgpu)`);
// In FALSIFY=ssao-wrong-input mode, the negative-bias throw inside
// buildGraph may interrupt the per-frame loop before SMOKE_MIN_FRAMES;
// relax this floor so the validation-fired assertion is the load-bearing
// signal (Round-2 [F-4]).
if (!ssaoWrongInput && totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

if (ssaoWrongInput) {
  // Round-2 [F-4] FALSIFY=ssao-wrong-input: register SSAO with bias=-1.0
  // (negative). The parameter validation in addSsaoPasses must catch this
  // — ssao-bias-negative is thrown synchronously inside buildGraph, which
  // crashes the per-frame execute path; the engine's host-fanout funnel
  // surfaces the error to the host onError listener. Smoke validates EITHER
  // the onError event fires OR the perFramePassNames did NOT include
  // ssao-* (because buildGraph threw before wiring ssao passes). Both
  // outcomes prove the validation path actually fires; lack of either
  // means the validation is silently bypassed.
  const biasFires = onErrorEvents.filter((e) => e.code === 'ssao-bias-negative');
  const consoleHasBiasError = consoleErrors.some((line) => line.includes('ssao-bias-negative'));
  const ssaoPassesAbsent = !passNames.has('ssao-calc') && !passNames.has('ssao-blur');
  const validationFired = biasFires.length > 0 || consoleHasBiasError || ssaoPassesAbsent;
  if (!validationFired) {
    failures.push(
      '(c-FALSIFY-wrong-input) expected ssao-bias-negative to fire (onError / console) ' +
        'OR ssao-calc/ssao-blur passes to be absent when bias=-1.0; neither happened, ' +
        'so parameter validation is silently bypassed.',
    );
  }
} else if (ssaoEnabled) {
  if (!passNames.has('ssao-calc'))
    failures.push('(c) perFramePassNames missing ssao-calc');
  if (!passNames.has('ssao-blur'))
    failures.push('(d) perFramePassNames missing ssao-blur');
} else {
  if (passNames.has('ssao-calc'))
    failures.push('(c-FALSIFY-off) perFramePassNames has ssao-calc but SSAO is disabled');
  if (passNames.has('ssao-blur'))
    failures.push('(d-FALSIFY-off) perFramePassNames has ssao-blur but SSAO is disabled');
}

// In FALSIFY=ssao-wrong-input mode the negative-bias throw inside
// addSsaoPasses bubbles up through buildGraph; the renderer translates
// every per-frame throw into a `webgpu-runtime-error` via the onError
// channel. Both `ssao-bias-negative` (if surfaced verbatim) and
// `webgpu-runtime-error` (the wrap form) are EXPECTED in this mode and
// stripped from the unknown-error filter; the validation-fired assertion
// above is the load-bearing signal.
const expectedSsaoCodes = ssaoWrongInput
  ? new Set(['ssao-bias-negative', 'webgpu-runtime-error'])
  : new Set();
const unknownErrors = onErrorEvents.filter(
  (e) => !KNOWN_NOISE_CODES.has(e.code) && !expectedSsaoCodes.has(e.code),
);
if (unknownErrors.length > 0) {
  failures.push(
    `(e) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

// In FALSIFY=ssao-wrong-input mode, ssao-bias-negative is the EXPECTED
// console.error from the validation throw funnelled through the host
// fan-out; strip it from the unexpected-console filter.
const unexpectedConsoleErrors = consoleErrors.filter(
  (e) =>
    !e.includes('[smoke]') &&
    !(ssaoWrongInput && e.includes('ssao-bias-negative')),
);
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(f) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, frames=${totalFrames}, ssaoEnabled=${ssaoEnabled}, ` +
  `passNames.has(ssao-calc)=${passNames.has('ssao-calc')}, passNames.has(ssao-blur)=${passNames.has('ssao-blur')}, ` +
  `onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);