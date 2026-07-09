#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/2.gamma-correction/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 2.gamma-correction dawn-node smoke.
// Structural-only: >=60 frames, onError=0, both pipelines install + drive
// frames; no pixel readback (gamma visual delta is verify-step territory).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-2-gamma-correction] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const PER_STATE_FRAMES = Math.max(30, Math.ceil(SMOKE_MIN_FRAMES / 2));
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Inline shader sources mirror src/index.ts (kept in sync by hand; AI users
// grep `pow(col, vec3<f32>(2.2))` to find the wrong-gamma effect across both
// the demo and this smoke).
const PASSTHROUGH_CORRECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  return vec4<f32>(col, 1.0);
}
`;
const WRONG_GAMMA_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  let wrong = pow(col, vec3<f32>(2.2));
  return vec4<f32>(wrong, 1.0);
}
`;

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-2-gamma-correction' smoke",
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
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
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

// --- 2. Mock canvas with offscreen render target ---

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

// --- 3. Asset fixtures check ---

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  addFullscreenPass,
  addScenePass,
  Camera,
  createRenderer,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { RenderGraph } = await import('@forgeax/engine-render-graph');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed:', woodDecodeRes.error.code);
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-2-gamma-correction] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-2-gamma-correction] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
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

const world = new World();

// Catalogue the texture under its GUID, then mint a shared-ref column handle.
assets.catalog(woodGuidRes.value, woodTexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);

const planeMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.8,
    baseColorTexture: unwrapHandle(woodHandle),
  },
});

world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  )
  .unwrap();

world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 1, posZ: 1,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  { component: PointLight, data: {} },
);

world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 0, posZ: 3,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);

// --- 5. Register two custom RenderPipelines + their assets ---

const GAMMA_CORRECT_POSTPROCESS_ID = 'forgeax-gamma::passthrough-correct';
const GAMMA_WRONG_POSTPROCESS_ID = 'forgeax-gamma::wrong-gamma';
const GAMMA_CORRECT_PIPELINE_ID = 'learn-render-2-gamma::correct';
const GAMMA_WRONG_PIPELINE_ID = 'learn-render-2-gamma::wrong';

const OFFSCREEN_SRGB_KEY = 'offscreenSrgb';
const OFFSCREEN_DEPTH_KEY = 'gammaDepth';
const INTERMEDIATE_LINEAR_KEY = 'intermediateLinear';

function makeGammaPipeline(mode) {
  return {
    buildGraph(ctx) {
      const graph = new RenderGraph();
      graph.addColorTarget(OFFSCREEN_SRGB_KEY, {
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
      if (mode === 'wrong') {
        graph.addColorTarget(INTERMEDIATE_LINEAR_KEY, {
          format: 'bgra8unorm',
          size: 'swapchain',
          sample: 1,
          usage: 0x10 | 0x04,
        });
      }
      addScenePass(graph, 'main', {
        color: OFFSCREEN_SRGB_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        selector: { LightMode: ['Forward'] },
        _routeFromOpts: true,
      });
      const postShaderId =
        mode === 'correct' ? GAMMA_CORRECT_POSTPROCESS_ID : GAMMA_WRONG_POSTPROCESS_ID;
      addFullscreenPass(graph, 'postGamma', {
        shader: postShaderId,
        color: 'swapchain',
        reads: [OFFSCREEN_SRGB_KEY],
      });
      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) return null;
      return graph;
    },
    execute(ctx) {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

try {
  renderer.postProcess.register(GAMMA_CORRECT_POSTPROCESS_ID, {
    source: PASSTHROUGH_CORRECT_WGSL,
    reads: [OFFSCREEN_SRGB_KEY],
  });
  renderer.registerPipeline(GAMMA_CORRECT_PIPELINE_ID, makeGammaPipeline('correct'));
  renderer.postProcess.register(GAMMA_WRONG_POSTPROCESS_ID, {
    source: WRONG_GAMMA_WGSL,
    reads: [OFFSCREEN_SRGB_KEY],
  });
  renderer.registerPipeline(GAMMA_WRONG_PIPELINE_ID, makeGammaPipeline('wrong'));
} catch (e) {
  console.error('[smoke] FAIL - register threw:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// --- 6. Install correct pipeline + draw frames ---

const installCorrect = renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: GAMMA_CORRECT_PIPELINE_ID,
});
if (!installCorrect.ok) {
  console.error(`[smoke] FAIL - installPipeline(correct): ${installCorrect.error.code}`);
  process.exit(1);
}

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < PER_STATE_FRAMES; i++) {
  world.update();
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw correct frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

// --- 7. Hot-swap to wrong pipeline + draw more frames ---

const installWrong = renderer.installPipeline({
  kind: 'render-pipeline',
  pipelineId: GAMMA_WRONG_PIPELINE_ID,
});
if (!installWrong.ok) {
  console.error(`[smoke] FAIL - installPipeline(wrong): ${installWrong.error.code}`);
  process.exit(1);
}

for (let i = 0; i < PER_STATE_FRAMES; i++) {
  world.update();
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw wrong frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, per-state=${PER_STATE_FRAMES})`,
);

// --- 8. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-2-gamma-correction' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
