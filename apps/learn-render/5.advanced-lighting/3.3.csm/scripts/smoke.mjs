#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/3.3.csm/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M4 / M4-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3 cascaded shadow maps dawn-node smoke
// (structural-only). Spawns a large wood floor + 10 cubes spanning 0-40m depth
// + DirectionalLight + DirectionalLightShadow (cascadeCount=4, splitLambda=
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
//   - FALSIFY=force-no-shadow-pass : omit DirectionalLightShadow -> no
//     shadowCascade* pass (proves the shadowCascade assertion can fail).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-3-csm] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const WIDTH = 512;
const HEIGHT = 512;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

// Known-noise app.onError codes during shadow demos.
const KNOWN_NOISE_CODES = new Set([
  'shadow-disabled-by-missing-component',
]);

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
const {
  Camera,
  createPlaneGeometry,
  DirectionalLight,
  DirectionalLightShadow,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
  URP_PIPELINE_ID,
} = runtimePkg;

const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const appResult = await createApp(mockCanvas, { input: false }, { shaderManifestUrl: MANIFEST_URL });
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
      shader: 'forgeax::default-standard-pbr',
      fragmentEntry: 'fs_main',
      tags: { LightMode: 'Forward' },
      passKind: 'forward',
    },
    {
      name: 'ShadowCaster',
      shader: 'forgeax::default-shadow-caster',
      tags: { LightMode: 'ShadowCaster' },
      passKind: 'shadow-caster',
    },
  ],
  paramValues: {
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
    data: { posY: -0.5, quatX: FLOOR_QUAT_X, quatW: FLOOR_QUAT_W },
  },
  { component: MeshFilter, data: { assetHandle: floorMesh } },
  { component: MeshRenderer, data: { materials: [floorMat] } },
).unwrap();

const cubes = [
  { posX: -2, posY: 0.5, posZ: -1, scaleX: 1, scaleY: 1, scaleZ: 1, color: [1, 0.3, 0.3] },
  { posX: 2, posY: 1, posZ: -4, scaleX: 1, scaleY: 2, scaleZ: 1, color: [0.3, 1, 0.3] },
  { posX: -3, posY: 0.75, posZ: -8, scaleX: 1.5, scaleY: 1.5, scaleZ: 1.5, color: [0.3, 0.3, 1] },
  { posX: 3, posY: 0.5, posZ: -12, scaleX: 1, scaleY: 1, scaleZ: 1, color: [1, 1, 0.3] },
  { posX: -1, posY: 1.5, posZ: -16, scaleX: 1, scaleY: 3, scaleZ: 1, color: [1, 0.3, 1] },
  { posX: 4, posY: 1, posZ: -22, scaleX: 2, scaleY: 2, scaleZ: 2, color: [0.3, 1, 1] },
  { posX: -4, posY: 0.75, posZ: -28, scaleX: 1.5, scaleY: 1.5, scaleZ: 1.5, color: [0.8, 0.5, 0.2] },
  { posX: 1, posY: 1, posZ: -33, scaleX: 1, scaleY: 2, scaleZ: 1, color: [0.5, 0.5, 0.9] },
  { posX: -2, posY: 1.5, posZ: -38, scaleX: 2, scaleY: 3, scaleZ: 2, color: [0.9, 0.6, 0.6] },
  { posX: 3, posY: 1, posZ: -40, scaleX: 1.5, scaleY: 2, scaleZ: 1.5, color: [0.6, 0.9, 0.6] },
];
for (const c of cubes) {
  const [r, g, b] = c.color;
  const mat = Materials.standard({ baseColor: [r, g, b, 1] });
  const matHandle = world.allocSharedRef('MaterialAsset', mat);
  world.spawn(
    {
      component: Transform,
      data: {
        posX: c.posX, posY: c.posY, posZ: c.posZ,
        quatW: 1,
        scaleX: c.scaleX, scaleY: c.scaleY, scaleZ: c.scaleZ,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();
}

// Directional light with 4-cascade CSM shadow. FALSIFY=force-no-shadow-pass
// omits the shadow component (proves the shadowCascade assertion can fail).
const shadowPresent = FALSIFY !== 'force-no-shadow-pass';
if (shadowPresent) {
  world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: 0.3, directionY: -0.9, directionZ: -0.3,
        colorR: 1, colorG: 1, colorB: 1, intensity: 1,
      },
    },
    {
      component: DirectionalLightShadow,
      data: { cascadeCount: 4, splitLambda: 0.75, cascadeBlend: 0.2, mapSize: 2048, nearPlane: 0.1, farPlane: 50 },
    },
  ).unwrap();
} else {
  console.log('[smoke] FALSIFY=force-no-shadow-pass -- DirectionalLightShadow omitted');
  world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: 0.3, directionY: -0.9, directionZ: -0.3,
        colorR: 1, colorG: 1, colorB: 1, intensity: 1,
      },
    },
  ).unwrap();
}

// Camera at (0, 1.5, 6) facing -Z.
world.spawn(
  {
    component: Transform,
    data: { posY: 1.5, posZ: 6, quatW: 1 },
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearR: 0.02,
      clearG: 0.02,
      clearB: 0.04,
    },
  },
).unwrap();

// --- 7b. Install the cascade-overlay via the M4' post-URP post-process hook ---
// (the overlay is debug-viz layered on URP; the shadows ride URP unchanged).
// FALSIFY=force-cascade-overlay-off installs URP with an empty postEffects list
// -> no post-effect pass, but shadowCascade* passes survive.

const OVERLAY_PP_ID = 'learn-render-5-3-3-csm-smoke::overlay';

// Minimal valid overlay fragment matching the dispatcher's @group(1) input BGL
// (binding 0 = scene texture, binding 1 = sampler). The production overlay's
// PSSM tint + mat4_inverse live in src/cascade-overlay.wgsl; the smoke is
// structural so it uses a constant-tint stand-in.
const OVERLAY_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}
@group(1) @binding(0) var sceneTexture : texture_2d<f32>;
@group(1) @binding(1) var sceneSampler : sampler;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, sceneSampler, in.uv).rgb;
  return vec4<f32>(mix(scene, vec3<f32>(0.2, 0.85, 0.3), 0.45), 1.0);
}
`;

const overlayEnabled = FALSIFY !== 'force-cascade-overlay-off';
if (overlayEnabled) {
  app.renderer.postProcess.register(OVERLAY_PP_ID, { source: OVERLAY_WGSL });
}
const installRes = app.renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: URP_PIPELINE_ID,
  config: { postEffects: overlayEnabled ? [OVERLAY_PP_ID] : [] },
});
if (!installRes.ok) {
  console.error('[smoke] FAIL - installPipeline(urp + overlay):', installRes.error.code, installRes.error.hint);
  process.exit(1);
}
console.log(
  overlayEnabled
    ? '[smoke] URP installed with cascade overlay post-effect (AUGMENT: shadows + overlay)'
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

const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);
console.log(`[smoke] perFramePassNames=${JSON.stringify(passNames)}`);

// --- 9. Verdict (structural-only) ---

// URP declares a fallback single shadowCascade0 even with NO DirectionalLightShadow
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

// (e) 4-cascade CSM: the demo spawns cascadeCount=4, so the graph MUST contain
// exactly 4 shadowCascade passes. This is the assertion the prior
// installPipeline-replacement smoke could not make (it REPLACED URP and dropped
// every shadow pass yet stayed green). FALSIFY=force-no-shadow-pass omits the
// component -> URP falls back to a single shadowCascade0 (count 1, not 4),
// flipping this assertion.
if (shadowPresent && shadowCascadeCount !== 4) {
  failures.push(
    `(e) expected 4 shadowCascade passes (cascadeCount=4), got ${shadowCascadeCount} -- ${JSON.stringify(passNames)}`,
  );
}
if (!shadowPresent && shadowCascadeCount !== 1) {
  failures.push(
    `(e) expected 1 fallback shadowCascade pass (no DirectionalLightShadow), got ${shadowCascadeCount}`,
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

// (g) AUGMENT guarantee: all 4 shadow cascades survive even with the overlay on
// (the whole point of the M4' fix -- the overlay layers on top, it does not
// replace URP and drop its shadow passes).
if (overlayEnabled && shadowPresent && !(shadowCascadeCount === 4 && hasPostEffectPass)) {
  failures.push(
    `(g) AUGMENT broken: expected 4 shadowCascade + a post-effect pass, got cascades=${shadowCascadeCount} overlay=${hasPostEffectPass}`,
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
  `[smoke] PASS - 7 criteria GREEN: backend=webgpu, frames=${totalFrames}, shadowCascades=${shadowCascadeCount}, overlayPass=${hasPostEffectPass}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
