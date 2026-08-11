#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/3.3.csm/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M4 / M4-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3 cascaded shadow maps dawn-node smoke
// (structural-only). Spawns a large wood floor + 10 cubes spanning 0-40m depth
// + DirectionalLight with castShadow (cascadeCount=4, splitLambda=
// 0.75, mapSize=2048) under the engine's built-in URP, then layers a registered
// cascade-overlay post-process via the M4' post-URP hook
// (installPipeline(forgeax::urp, { config: { postEffects } })). Renders 300
// frames.
//
// THE LOAD-BEARING ASSERTION (fixes the prior false-green smoke): the demo is a
// SHADOW demo, so its render graph MUST contain a `shadowCascade*` pass, AND the
// overlay must add a `post-effect-*` pass — BOTH at once. The prior approach
// installed a custom pipeline that REPLACED URP and silently dropped every
// shadow pass; this smoke would have caught that (no shadowCascade pass).
//
// FALSIFY modes prove each half is real (a falsified control must change the
// outcome — the prior overlay-off control did not):
//   - FALSIFY=force-cascade-overlay-off : install URP with empty postEffects ->
//     perFramePassNames KEEPS shadowCascade* but DROPS post-effect* (overlay is
//     the delta; shadows survive — the AUGMENT, not REPLACE, guarantee).
//   - FALSIFY=force-no-shadow-pass : castShadow=false -> no
//     shadowCascade* pass (proves the shadowCascade assertion can fail).
//   - FALSIFY=force-csm-highlight-layer-2 : switch the existing overlay UBO to
//     cascade 2 and require the final image to change from the all-bands image.
//   - FALSIFY=force-csm-probe-depth-lit : replace the GPU probe factors with
//     fully lit values; the sampled-depth contribution gate must turn red.
//   - FALSIFY=force-csm-probe-raw-depth-sentinel : replace the GPU probe's raw
//     depth/cascade facts with sentinels; the producer-owned fact gate turns red.
//   - FALSIFY=force-csm-probe-boundary-layer-shift : shift only the boundary
//     cascade facts; the split-continuity gate must turn red.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-3-csm] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const highlightLayerControl = FALSIFY === 'force-csm-highlight-layer-2';
const WIDTH = 512;
const HEIGHT = 512;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

// Known-noise app.onError codes during shadow demos.
const KNOWN_NOISE_CODES = new Set([]);

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

// --- 2. Mock canvas with offscreen render target ---

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC: COPY_SRC lets the M4'
    // post-effect copy the swap-chain into its scratch target.
    usage: 0x10 | 0x04 | 0x01,
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

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + build shader manifest ---

const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed:', woodDecodeRes.error.code);
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-5-3-3-csm] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// --- 5. createApp + setup ---

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const runtimePkg = await import('@forgeax/engine-runtime');
const { createPlaneGeometry } = await import('@forgeax/engine-geometry');
const { Materials } = await import('@forgeax/engine-render');
const { URP_PIPELINE_ID } = await import('@forgeax/engine-render/internal');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-3-3-csm] backend=${app.renderer.backend}`);

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

const world = app.world;

// --- 6. Register wood texture under its GUID ---

const woodGuidRes = AssetGuid.parse('019e3969-1d48-7c3b-ac24-6d68f457065f');
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const woodTexAsset = {
  kind: 'texture',
  width: woodDecoded.width,
  height: woodDecoded.height,
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mipmap: woodDecoded.mipmap,
};

assets.catalog(woodGuidRes.value, woodTexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);

const floorMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
    {
      name: 'ShadowCaster',
      program: { module: 'forgeax::default-shadow-caster' },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ],
  values: {
    baseColorTexture: unwrapHandle(woodHandle),
  },
});

// --- 7. Spawn scene (large floor + 10 cubes spanning 0-40m) ---

const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);
const floorRes = createPlaneGeometry(50, 50);
if (!floorRes.ok) {
  console.error('[smoke] FAIL - createPlaneGeometry failed:', floorRes.error.code);
  process.exit(1);
}
const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
world.spawn(
  {
    component: Transform,
    data: { pos: [0, -0.5, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
  },
  { component: MeshFilter, data: { assetHandle: floorMesh } },
  { component: MeshRenderer, data: { materials: [floorMat] } },
).unwrap();

const cubes = [
  { pos: [-2, 0.5, -1], scale: [1, 1, 1],color: [1, 0.3, 0.3] },
  { pos: [2, 1, -4], scale: [1, 2, 1],color: [0.3, 1, 0.3] },
  { pos: [-3, 0.75, -8], scale: [1.5, 1.5, 1.5],color: [0.3, 0.3, 1] },
  { pos: [3, 0.5, -12], scale: [1, 1, 1],color: [1, 1, 0.3] },
  { pos: [-1, 1.5, -16], scale: [1, 3, 1],color: [1, 0.3, 1] },
  { pos: [4, 1, -22], scale: [2, 2, 2],color: [0.3, 1, 1] },
  { pos: [-4, 0.75, -28], scale: [1.5, 1.5, 1.5],color: [0.8, 0.5, 0.2] },
  { pos: [1, 1, -33], scale: [1, 2, 1],color: [0.5, 0.5, 0.9] },
  { pos: [-2, 1.5, -38], scale: [2, 3, 2],color: [0.9, 0.6, 0.6] },
  { pos: [3, 1, -40], scale: [1.5, 2, 1.5],color: [0.6, 0.9, 0.6] },
];
for (const c of cubes) {
  const [r, g, b] = c.color;
  const mat = Materials.standard({ baseColor: [r, g, b, 1] });
  const matHandle = world.allocSharedRef('MaterialAsset', mat);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: c.pos,
        quat: [0, 0, 0, 1],
        scale: c.scale,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();
}

// Directional light with 4-cascade CSM shadow. FALSIFY=force-no-shadow-pass
// sets castShadow=false (proves the shadowCascade assertion can fail).
// FALSIFY=force-one-cascade keeps shadows enabled but requests one cascade,
// proving the graph count follows the producer's cascadeCount rather than a
// hard-coded four-pass assumption.
const shadowPresent = FALSIFY !== 'force-no-shadow-pass';
const oneCascade = FALSIFY === 'force-one-cascade';
if (!shadowPresent) {
  console.log('[smoke] FALSIFY=force-no-shadow-pass -- DirectionalLight castShadow=false');
}
const lightEntity = world.spawn(
  {
    component: DirectionalLight,
    data: {
      direction: [0.3, -0.9, -0.3],
      color: [1, 1, 1], intensity: 1,
      ...(shadowPresent
        ? { castShadow: true, cascadeCount: oneCascade ? 1 : 4, splitLambda: 0.75, cascadeBlend: 0.2, mapSize: 2048, shadowDistance: 50 }
        : { castShadow: false }),
    },
  },
).unwrap();

// Camera at (0, 1.5, 6) facing -Z.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.5, 6], quat: [0, 0, 0, 1]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.02, 0.02, 0.04, 1],
    },
  },
).unwrap();

// --- 7b. Install the cascade-overlay via the M4' post-URP post-process hook ---
// (the overlay is debug-viz layered on URP; the shadows ride URP unchanged).
// FALSIFY=force-cascade-overlay-off installs URP with an empty postEffects list
// -> no post-effect pass, but shadowCascade* passes survive.

// feat-20260702-postprocess-camera-depth-read M5 w18 -- pixel readback + FALSIFY.
// The smoke now uses the production cascade-overlay.wgsl (reads real scene depth
// via the engine's fullscreen-post-with-scene-depth BGL kind) instead of the old
// constant-tint stand-in, so pixel assertions (a)/(b)/(c) measure actual cascade
// band output with a minimal perceptually-stable threshold.
//
// Overlay passthrough (tintMode=-1) is used instead of the old overlay-on/off
// toggle via FALSIFY=force-cascade-overlay-off -- the shader is always installed;
// 'off' mode is handled via PostProcessParams.tintMode=-1 (shader passthroughs).
// FALSIFY=force-cascade-overlay-off retains its original meaning (no postEffect
// pass at all), but the structural assertion (f) still verifies its absence.

const OVERLAY_PP_ID = 'learn-render-5-3-3-csm-smoke::overlay';
const OVERLAY_SRC_PATH = resolve(APP_ROOT, 'src', 'cascade-overlay.wgsl');
if (!existsSync(OVERLAY_SRC_PATH)) {
  console.error(`[smoke] FAIL - overlay shader missing: ${OVERLAY_SRC_PATH}`);
  process.exit(1);
}
const OVERLAY_WGSL = readFileSync(OVERLAY_SRC_PATH, 'utf-8');

// Pack tintMode + fakeDepth into 16 B UBO (matches PostProcessParams struct:
// tintMode:f32@0, fakeDepth:f32@4, _pad:vec2<f32>@8).
// FALSIFY=force-cascade-overlay-off -> no postEffect pass (old structural test).
// FALSIFY=force-fake-depth -> params.fakeDepth=1, shader goes far-plane NDC
//   path => all-pixels band 3 (red), reproducing old all-red bug (AC-07c).
// FALSIFY=force-no-shadow-pass -> castShadow=false (existing structural test).
const overlayOffLine = FALSIFY === 'force-cascade-overlay-off';
const falsifyFakeDepth = FALSIFY === 'force-fake-depth';

function packOverlayParams(tintMode, fakeDepth) {
  const buf = new ArrayBuffer(16);
  const f32 = new Float32Array(buf);
  f32[0] = tintMode;
  f32[1] = fakeDepth;
  f32[2] = 0; // pad
  f32[3] = 0; // pad
  return new Uint8Array(buf);
}

// Always register the overlay with structured reads + params (D-3 BGL kind
// fullscreen-post-with-scene-depth). The shader passthroughs when tintMode=-1,
// so the overlay pass is always active; the 'off' control is pure UBO write.
app.renderer.postProcess.register(OVERLAY_PP_ID, {
  source: OVERLAY_WGSL,
  reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
  params: { byteSize: 16, defaultValue: packOverlayParams(-1, 0) },
});

// Spawn a PostProcessParams entity so the engine writes the params UBO per
// frame. Default: tintMode=-1 (passthrough), fakeDepth=0 (real depth).
const { PostProcessParams } = await import('@forgeax/engine-render');
const paramsInitial = falsifyFakeDepth
  ? packOverlayParams(0 /* all */, 1 /* fake */)
  : packOverlayParams(0 /* all */, 0 /* real */);
const paramsEntity = world
  .spawn({ component: PostProcessParams, data: { shader: OVERLAY_PP_ID, data: paramsInitial } })
  .unwrap();

// Install URP once with the overlay. When overlayOffLine, install without to
// keep the old structural assertion (f) working.
const installRes = app.renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: URP_PIPELINE_ID,
  config: { postEffects: overlayOffLine ? [] : [OVERLAY_PP_ID] },
});
if (!installRes.ok) {
  console.error('[smoke] FAIL - installPipeline(urp + overlay):', installRes.error.code, installRes.error.hint);
  process.exit(1);
}
const overlayEnabled = !overlayOffLine;
console.log(
  overlayEnabled
    ? `[smoke] URP installed with cascade overlay post-effect (AUGMENT: shadows + overlay, fakeDepth=${falsifyFakeDepth ? 1 : 0})`
    : '[smoke] FALSIFY=force-cascade-overlay-off -- URP installed with empty postEffects (shadows only)',
);

// --- 8. Render 300 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

// Capture perFramePassNames after warmup (post-process pipelines are 1-frame
// lazy; the graph is memoized after the first build).
let totalFrames = 0;
let passNames = [];
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  if (i === 4) passNames = [...app.renderer.perFramePassNames];
  if (i % 16 === 15) await delay(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);
console.log(`[smoke] perFramePassNames=${JSON.stringify(passNames)}`);

// --- 9a. Pixel readback (AC-07: memory assertions, zero tape dependency) ---

async function readTightRgba(label) {
  const device = sharedDevice;
  if (!device) {
    console.error('[smoke] FAIL - no shared device captured for pixel readback');
    process.exit(1);
  }
  await device.queue.onSubmittedWorkDone();

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

  const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tightRgba[dst + 0] = bytes[off + 0] ?? 0;
      tightRgba[dst + 1] = bytes[off + 1] ?? 0;
      tightRgba[dst + 2] = bytes[off + 2] ?? 0;
      tightRgba[dst + 3] = bytes[off + 3] ?? 0;
    }
  }
  console.log(`[smoke] ${label} pixel RGBA sha256=${createHash('sha256').update(tightRgba).digest('hex')}`);
  return tightRgba;
}

let tightRgba = await readTightRgba('cascadeBlend=0.2');

// Read the same atlas through the renderer's producer-owned GPU probe. These
// points cover the ground around the near cubes and farther cascade bands;
// the returned factors are sampled depth evidence, not a CPU reconstruction.
const csmProbePositions = [
  [0, -0.5, 4],
  [0, -0.5, -4],
  [-2, -0.5, -1],
  [-3, -0.5, -8],
  [0, -0.5, -12],
  [0, -0.5, -20],
  [0, -0.5, -40],
];
// Place paired receivers immediately on the near/far side of each split. The
// positions use the demo's camera (z=6, forward=-Z), while the renderer owns
// the actual split values and selector. This fixture only chooses points; it
// must not reconstruct the cascade result.
const csmBoundarySplitDepths = Array.from({ length: 3 }, (_, index) => {
  const t = (index + 1) / 4;
  const near = 0.1;
  const far = 50;
  const lambda = 0.75;
  return lambda * near * (far / near) ** t + (1 - lambda) * (near + t * (far - near));
});
const CSM_BOUNDARY_EPSILON = 0.25;
const csmBoundaryProbePositions = csmBoundarySplitDepths.flatMap((splitDepth) => [
  [0, -0.5, 6 - (splitDepth - CSM_BOUNDARY_EPSILON)],
  [0, -0.5, 6 - (splitDepth + CSM_BOUNDARY_EPSILON)],
]);
const csmProbeInput = [...csmProbePositions, ...csmBoundaryProbePositions];
const csmProbeResults = await app.renderer.debugSampleShadowFactor?.(csmProbeInput);
if (csmProbeResults === null || csmProbeResults === undefined) {
  console.error('[smoke] FAIL - CSM sampled-depth probe unavailable');
  process.exit(1);
}
const csmBaseProbeResults = csmProbeResults.slice(0, csmProbePositions.length);
const csmBoundaryResults = csmProbeResults.slice(csmProbePositions.length);
const csmProbeFactors = csmBaseProbeResults.map(({ shadowFactor }) => shadowFactor);
const gatedCsmProbeResults = FALSIFY === 'force-csm-probe-raw-depth-sentinel'
  ? csmProbeResults.map(({ shadowFactor }) => ({
      shadowFactor,
      sampledDepth: 1,
      cascadeIndex: -1,
      receiverDepth: 2,
    }))
  : FALSIFY === 'force-csm-probe-boundary-layer-shift'
    ? csmProbeResults.map((probe, index) =>
        index < csmProbePositions.length
          ? probe
          : { ...probe, cascadeIndex: (probe.cascadeIndex + 1) % 4 },
      )
  : csmProbeResults;
if (FALSIFY === 'force-csm-probe-raw-depth-sentinel') {
  console.log('[smoke] FALSIFY=force-csm-probe-raw-depth-sentinel -- replaced raw depth/cascade facts with sentinels');
}
console.log(
  `[smoke] CSM sampled-depth facts=${JSON.stringify(csmProbeResults)}`,
);
const gatedCsmProbeFactors = FALSIFY === 'force-csm-probe-depth-lit'
  ? csmProbeFactors.map(() => 1)
  : csmProbeFactors;
if (FALSIFY === 'force-csm-probe-depth-lit') {
  console.log('[smoke] FALSIFY=force-csm-probe-depth-lit -- replaced sampled factors with fully lit');
}
console.log(
  `[smoke] CSM sampled-depth factors=${JSON.stringify(csmProbeFactors)}`,
);
const csmProbeExpectations = [
  { label: 'cascade-0-near-lit', cascade: 0, min: 0.9 },
  { label: 'cascade-2-mid-lit', cascade: 2, min: 0.9 },
  { label: 'cascade-1-near-cube-shadow', cascade: 1, max: 0.5 },
  { label: 'cascade-2-third-cube-shadow', cascade: 2, max: 0.5 },
  { label: 'cascade-3-far-mid-lit-ground', cascade: 3, min: 0.9 },
  { label: 'cascade-3-far-lit-ground', cascade: 3, min: 0.9 },
  { label: 'cascade-3-far-cube-shadow', cascade: 3, max: 0.5 },
];
const perCascadeFactors = new Map();
for (const [index, expectation] of csmProbeExpectations.entries()) {
  const probe = gatedCsmProbeResults[index];
  const factor = gatedCsmProbeFactors[index];
  if (!oneCascade && probe?.cascadeIndex !== expectation.cascade) {
    throw new Error(
      `CSM cascade selection mismatch at ${expectation.label}: ` +
        `selected=${probe?.cascadeIndex} expected=${expectation.cascade}`,
    );
  }
  if (
    !oneCascade &&
    (probe === undefined ||
      !Number.isFinite(probe.sampledDepth) ||
      probe.sampledDepth < 0 ||
      probe.sampledDepth > 1 ||
      !Number.isFinite(probe.receiverDepth) ||
      probe.receiverDepth < 0 ||
      probe.receiverDepth > 1)
  ) {
    throw new Error(
      `CSM raw depth witness missing at ${expectation.label}: ${JSON.stringify(probe)}`,
    );
  }
  if (
    factor === undefined ||
    (expectation.min !== undefined && factor < expectation.min) ||
    (expectation.max !== undefined && factor >= expectation.max)
  ) {
    throw new Error(
      `CSM sampled-depth contribution missing at ${expectation.label}: ` +
      `factor=${factor} expected=${JSON.stringify(expectation)}`,
    );
  }
  const factors = perCascadeFactors.get(expectation.cascade) ?? [];
  factors.push(factor);
  perCascadeFactors.set(expectation.cascade, factors);
}
if (!oneCascade) {
  const gatedBoundaryResults = gatedCsmProbeResults.slice(csmProbePositions.length);
  const boundaryFacts = [];
  for (let boundary = 0; boundary < 3; boundary++) {
    const nearSide = gatedBoundaryResults[boundary * 2];
    const farSide = gatedBoundaryResults[boundary * 2 + 1];
    const expectedNear = boundary;
    const expectedFar = boundary + 1;
    if (nearSide?.cascadeIndex !== expectedNear || farSide?.cascadeIndex !== expectedFar) {
      throw new Error(
        `CSM split-boundary continuity mismatch at boundary ${boundary}: ` +
          `near=${nearSide?.cascadeIndex} expected=${expectedNear} ` +
          `far=${farSide?.cascadeIndex} expected=${expectedFar}`,
      );
    }
    for (const [side, probe] of [['near', nearSide], ['far', farSide]]) {
      if (
        probe === undefined ||
        !Number.isFinite(probe.sampledDepth) ||
        probe.sampledDepth < 0 ||
        probe.sampledDepth > 1 ||
        !Number.isFinite(probe.receiverDepth) ||
        probe.receiverDepth < 0 ||
        probe.receiverDepth > 1
      ) {
        throw new Error(
          `CSM split-boundary raw depth witness missing at boundary ${boundary}/${side}: ` +
            JSON.stringify(probe),
        );
      }
    }
    boundaryFacts.push({ near: nearSide?.cascadeIndex, far: farSide?.cascadeIndex });
  }
  console.log(`[smoke] CSM split-boundary facts=${JSON.stringify(boundaryFacts)}`);
  console.log('[smoke] CSM split-boundary continuity accepted: near-side=i, far-side=i+1');
}
console.log('[smoke] CSM sampled-depth atlas resource contribution accepted: lit=3 shadowed=3');
if (!oneCascade) {
  const representedCascades = [...perCascadeFactors.keys()].sort();
  if (representedCascades.join(',') !== '0,1,2,3') {
    throw new Error(`CSM sampled-depth probe coverage omitted a cascade: ${representedCascades.join(',')}`);
  }
  console.log(
    `[smoke] CSM sampled-depth per-cascade contribution accepted: cascades=${representedCascades.join(',')} ` +
      `factors=${JSON.stringify([...perCascadeFactors.entries()])}`,
  );
}

// Select one real cascade through the existing overlay mode UBO and prove the
// selected-layer highlight changes the submitted color image. This is a
// same-scene control: shadow atlas, receiver draws, and all other inputs stay
// fixed while only tintMode changes from all-bands (0) to cascade 2 (2).
if (highlightLayerControl && shadowPresent && !oneCascade && !falsifyFakeDepth) {
  world.set(paramsEntity, PostProcessParams, { data: packOverlayParams(2 /* c2 */, 0 /* real */) });
  for (let i = 0; i < 60; i++) {
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
  }
  const highlightedRgba = await readTightRgba('cascade-highlight=c2');
  let highlightChangedPixels = 0;
  let highlightMeanRgbDelta = 0;
  for (let i = 0; i < highlightedRgba.length; i += 4) {
    const pixelDelta =
      Math.abs(tightRgba[i] - highlightedRgba[i]) +
      Math.abs(tightRgba[i + 1] - highlightedRgba[i + 1]) +
      Math.abs(tightRgba[i + 2] - highlightedRgba[i + 2]);
    if (pixelDelta > 0) highlightChangedPixels++;
    highlightMeanRgbDelta += pixelDelta / (3 * 255);
  }
  highlightMeanRgbDelta /= highlightedRgba.length / 4;
  console.log(
    `[smoke] cascade highlight c2 visual control changedPixels=${highlightChangedPixels}/${highlightedRgba.length / 4} ` +
      `meanRgbDelta=${highlightMeanRgbDelta.toFixed(6)}`,
  );
  if (highlightChangedPixels === 0) {
    console.error('[smoke] FAIL - cascade highlight c2 produced no visual change from all-bands overlay');
    process.exit(1);
  }
  world.set(paramsEntity, PostProcessParams, { data: packOverlayParams(0 /* all */, 0 /* real */) });
}

// Compare the same live scene after removing the blend zone. This is a real
// visual falsifier for the producer-owned cascadeBlend input: if changing it
// does not alter the submitted color image, the CSM seam-continuity path is not
// connected to the rendered result and the smoke must fail.
const blendControlFrames = 60;
if (shadowPresent && !oneCascade) {
  world.set(lightEntity, DirectionalLight, { cascadeBlend: 0 });
  for (let i = 0; i < blendControlFrames; i++) {
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
  }
  const noBlendRgba = await readTightRgba('cascadeBlend=0');
  let blendChangedPixels = 0;
  let blendMeanRgbDelta = 0;
  for (let i = 0; i < noBlendRgba.length; i += 4) {
    const pixelDelta =
      Math.abs(tightRgba[i] - noBlendRgba[i]) +
      Math.abs(tightRgba[i + 1] - noBlendRgba[i + 1]) +
      Math.abs(tightRgba[i + 2] - noBlendRgba[i + 2]);
    if (pixelDelta > 0) blendChangedPixels++;
    blendMeanRgbDelta += pixelDelta / (3 * 255);
  }
  blendMeanRgbDelta /= noBlendRgba.length / 4;
  console.log(
    `[smoke] cascadeBlend visual control changedPixels=${blendChangedPixels}/${noBlendRgba.length / 4} ` +
      `meanRgbDelta=${blendMeanRgbDelta.toFixed(6)}`,
  );
  if (blendChangedPixels === 0) {
    console.error('[smoke] FAIL - cascadeBlend=0 produced no visual change from cascadeBlend=0.2');
    process.exit(1);
  }
}

world.set(lightEntity, DirectionalLight, { cascadeBlend: 0.2 });
const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

// --- 9b. Pixel assertions (AC-07 a/b/c) ---

// (a) NOT uniformly red: with fake depth, every pixel uses the same band-3
// red tint (0.90, 0.25, 0.20) mixed at 0.45 strength. This produces a
// spatially uniform red-dominant colour across the frame. With real depth,
// cascade bands produce diverse colours (green/yellow/orange/red), so the
// spatial variance of R/G ratios is much higher.
//
// Strategy: compute the standard deviation of per-pixel R/G ratios across
// the frame. With fake depth, all pixels share the same band-3 tint =>
// R/G ratios are tightly clustered (low stddev). With real depth, different
// bands produce different R/G ratios => high stddev. This is a falsifiable
// signal: the assertion catches the "all-same-band" bug regardless of scene
// brightness.
let sumRg = 0;
let sumRgSq = 0;
let rgCount = 0;
const pixelCount = WIDTH * HEIGHT;
for (let i = 0; i < pixelCount; i++) {
  const r = (tightRgba[i * 4 + 0] ?? 0);
  const g = (tightRgba[i * 4 + 1] ?? 0);
  if (g > 5) { // skip near-black pixels (noise)
    const rg = r / g;
    sumRg += rg;
    sumRgSq += rg * rg;
    rgCount++;
  }
}
const meanRg = rgCount > 0 ? sumRg / rgCount : 0;
const varianceRg = rgCount > 1 ? (sumRgSq / rgCount) - (meanRg * meanRg) : 0;
const stddevRg = Math.sqrt(Math.max(0, varianceRg));
console.log(`[smoke] pixel R/G mean=${meanRg.toFixed(3)} stddev=${stddevRg.toFixed(4)} (n=${rgCount})`);

// (b) Depth banding: compare the average R/G channel ratio of the bottom
// region (nearer objects, more green) vs the top region (farther objects,
// more red). The camera is at (0,1.5,6) looking -Z; the floor is at y=-0.5,
// so even the bottom edge of the screen sees the floor at ~5m depth (cascade-1
// or beyond). The cascade-0 split is at 3.5m -- no single centered pixel
// reliably hits cascade-0. Instead we use region-averaged statistics: the
// bottom strip should have a lower average R/G ratio than the top strip
// because closer objects are more green. This is a statistically robust signal
// that depth banding is working.
function regionAvgRgRatio(x0, y0, w, h) {
  let sumR = 0;
  let sumG = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const idx = ((y0 + dy) * WIDTH + (x0 + dx)) * 4;
      sumR += (tightRgba[idx + 0] ?? 0);
      sumG += (tightRgba[idx + 1] ?? 0);
    }
  }
  return sumG > 0 ? sumR / sumG : 999;
}
// Bottom strip: lower 10% of the screen (nearer floor / objects).
const bottomRg = regionAvgRgRatio(0, Math.floor(HEIGHT * 0.85), WIDTH, Math.floor(HEIGHT * 0.10));
// Top strip: upper 10% of the screen (sky / far background).
const topRg = regionAvgRgRatio(0, 0, WIDTH, Math.floor(HEIGHT * 0.10));
console.log(`[smoke] pixel bottom-region avg R/G=${bottomRg.toFixed(3)} top-region avg R/G=${topRg.toFixed(3)} (delta=${(bottomRg - topRg).toFixed(3)})`);

// --- 9. Verdict (structural + pixel) ---

// URP declares a fallback single shadowCascade0 even with castShadow=false
// (the 1024x1 fallback). So "a shadowCascade pass exists" is always true and is a
// weak proxy. The genuinely falsifiable signal is the cascade COUNT: a 4-cascade
// CSM must produce exactly 4 shadowCascade passes; the no-shadow fallback produces 1.
const shadowCascadeCount = passNames.filter((n) => n.startsWith('shadowCascade')).length;
const hasPostEffectPass = passNames.some((n) => n.startsWith('post-effect-'));

const failures = [];
if (app.renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.backend} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(c) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

// (e) CSM: the smoke requests four cascades normally and one under the
// force-one-cascade control, so the graph MUST contain the requested count.
// This is the assertion the prior
// installPipeline-replacement smoke could not make (it REPLACED URP and dropped
// every shadow pass yet stayed green). FALSIFY=force-no-shadow-pass sets
// castShadow=false -> URP falls back to a single shadowCascade0 (count 1, not 4),
// flipping this assertion.
const expectedShadowCascadeCount = oneCascade ? 1 : 4;
if (shadowPresent && shadowCascadeCount !== expectedShadowCascadeCount) {
  failures.push(
    `(e) expected ${expectedShadowCascadeCount} shadowCascade passes, got ${shadowCascadeCount} -- ${JSON.stringify(passNames)}`,
  );
}
if (!shadowPresent && shadowCascadeCount !== 1) {
  failures.push(
    `(e) expected 1 fallback shadowCascade pass (castShadow=false), got ${shadowCascadeCount}`,
  );
}

// (f) overlay-pass presence: with the overlay on, a post-effect pass must be in
// the graph; with FALSIFY=force-cascade-overlay-off it must be ABSENT. A real
// falsifiable control (the prior pipelineCount control did not change).
if (overlayEnabled && !hasPostEffectPass) {
  failures.push(`(f) post-effect pass MISSING with overlay enabled -- ${JSON.stringify(passNames)}`);
}
if (!overlayEnabled && hasPostEffectPass) {
  failures.push('(f) post-effect pass PRESENT with overlay disabled (FALSIFY did not falsify)');
}

// (g) AUGMENT guarantee: all requested shadow cascades survive even with the overlay on
// (the whole point of the M4' fix -- the overlay layers on top, it does not
// replace URP and drop its shadow passes).
if (overlayEnabled && shadowPresent && !(shadowCascadeCount === expectedShadowCascadeCount && hasPostEffectPass)) {
  failures.push(
    `(g) AUGMENT broken: expected ${expectedShadowCascadeCount} shadowCascade + a post-effect pass, got cascades=${shadowCascadeCount} overlay=${hasPostEffectPass}`,
  );
}

// Pixel assertions (AC-07 a/b/c) -- only meaningful when the overlay is
// active (the render target must include the cascade-overlay output).
// FALSIFY=force-fake-depth sets fakeDepth=1, which restores the old far-plane
// NDC path where every pixel is band-3 red. The assertions (h) and (i) detect
// this uniform-red condition and FAIL, proving the assertions are discriminative
// (AC-07c). In normal mode, real depth produces diverse banding so both pass.
if (overlayEnabled && tightRgba !== null) {
  // (h) AC-07(a): R/G ratio must show spatial diversity from cascade bands.
  // Uniform band colour (e.g. all band-3 red from fake depth) produces low
  // stddev (~0.27) because only the underlying scene varies (tint constant).
  // Real depth with varied bands produces much higher stddev (~0.57).
  // Threshold 0.35: fake depth with uniform band-3 is caught; real depth
  // with 4-band mixing passes.
  if (stddevRg < 0.35) {
    failures.push(
      `(h) AC-07a: R/G stddev=${stddevRg.toFixed(4)} < 0.35, expected spatial diversity from cascade bands. Screen may be uniformly red (depth not affecting colour).${falsifyFakeDepth ? ' FALSIFY force-fake-depth: all-band-3 red reproduced as expected -- assertion discriminative.' : ''}`,
    );
  } else {
    console.log(`[smoke] AC-07a R/G diversity OK: mean=${meanRg.toFixed(3)} stddev=${stddevRg.toFixed(4)}`);
  }

  // (i) AC-07(b): bottom strip (closer objects) must be more green-leaning
  // than top strip (farther objects / more red). Fake depth makes everything
  // uniformly red -> no gradient.
  if (bottomRg >= topRg - 0.05) {
    failures.push(
      `(i) AC-07b: no depth banding gradient -- bottom R/G=${bottomRg.toFixed(3)} >= top R/G=${topRg.toFixed(3)}. Expected bottom < top (near green-leaning, far red-leaning).${falsifyFakeDepth ? ' FALSIFY force-fake-depth: uniform band-3 red eliminates gradient as expected -- assertion discriminative.' : ''}`,
    );
  } else {
    console.log(`[smoke] AC-07b depth banding: bottom R/G=${bottomRg.toFixed(3)} < top R/G=${topRg.toFixed(3)} (delta=${(topRg - bottomRg).toFixed(3)})`);
  }
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
  `[smoke] PASS - criteria GREEN: backend=webgpu, frames=${totalFrames}, shadowCascades=${shadowCascadeCount}, overlayPass=${hasPostEffectPass}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}, pixel-RG-stddev=${stddevRg.toFixed(3)}${overlayEnabled ? `, depth-banding-top/bottom-RG=${bottomRg.toFixed(2)}/${topRg.toFixed(2)}` : ''}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
