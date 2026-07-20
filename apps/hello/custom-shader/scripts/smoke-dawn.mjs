#!/usr/bin/env node
// hello-custom-shader headless smoke -- M9-T06 visible-pulse assertion.
//
// AC-14 acceptance gate: the pulse-material custom shader must produce a
// visibly oscillating colour over time. The smoke exercises the full
// per-MaterialShader pipeline cache (M9-T03) + paramValues mutation path
// end-to-end on dawn-node + wgpu-wasm.
//
// Strategy (mirrors hello-room smoke; charter P4 consistent abstraction):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + offscreen GPUCanvasContext.
//   3. import the engine-runtime + ECS path; createRenderer with the
//      built shader manifest.
//   4. shader.registerMaterialShader('my-game::pulse-material',
//      { source: composed wgsl, paramSchema, bindingLayout: [] }).
//      The composed wgsl is read out of dist/shaders/<hash>.composed.wgsl.
//   5. world.allocSharedRef('MaterialAsset', { kind:'material',
//      passes:[{shader:'my-game::pulse-material',...}], paramValues })
//      with the paramValues object held for per-frame mutation.
//   6. Spawn cube + camera + DirectionalLight; await renderer.ready.
//   7. For each of t={0, 0.5, 1.0} seconds: mutate paramValues.metallic
//      = t; draw 10 warm-up frames; copyTextureToBuffer + mapAsync;
//      sample the pixel at the cube center. Record [r, g, b] triple.
//   8. Brightness = (r + g + b) / 3.  Assert
//      |brightness(t=0.5) - brightness(t=0)| > BRIGHTNESS_DELTA_MIN_05
//      and |brightness(t=1.0) - brightness(t=0)| > BRIGHTNESS_DELTA_MIN_10
//      (visible pulse confirmed).
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-custom-shader] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pulseSamples=<json>`
//   - `[smoke] brightnessDelta_05=<num> delta_10=<num>`

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_FRAMES_PER_T = Number.parseInt(process.env.SMOKE_FRAMES_PER_T ?? '10', 10);
// AC-14: visible pulse means brightness(t) varies measurably over t in
// [0, 1]s. The pulse-material shader applies sin(time*speed)*0.25+0.75
// modulation -- with speed=2, sin(0)=0, sin(1)=sin(2)~0.909. Brightness
// span across t=0..1 is therefore ~0.5 * baseColor magnitude. The
// thresholds below are conservative against integration noise (lighting
// + Fresnel jitter pull samples around the analytic curve).
const BRIGHTNESS_DELTA_MIN_05 = Number.parseFloat(process.env.BRIGHTNESS_DELTA_MIN_05 ?? '0.05');
const BRIGHTNESS_DELTA_MIN_10 = Number.parseFloat(process.env.BRIGHTNESS_DELTA_MIN_10 ?? '0.03');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

// --- 1. dawn.node binding setup ---------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-custom-shader smoke');
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

// --- 2. Mock canvas with offscreen render target ----------------------------

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

// --- 3. Engine bootstrap ----------------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const {
  ANTIALIAS_MSAA,
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;

const MANIFEST_PATH = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
if (!existsSync(MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${MANIFEST_PATH}`);
  console.error('  hint: rebuild via `pnpm --filter @forgeax/hello-custom-shader build`');
  process.exit(1);
}
const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8');
const manifestParsed = JSON.parse(manifestRaw);
const MANIFEST_URL = `data:application/json,${encodeURIComponent(manifestRaw)}`;

// Locate the materialShaders[] entry for pulse-material + read its composed
// wgsl from the sibling sidecar file.
const matShaderEntry = (manifestParsed.materialShaders ?? []).find(
  (m) => m && typeof m.identifier === 'string' && m.identifier.includes('pulse_material'),
);
if (!matShaderEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing pulse_material entry');
  process.exit(1);
}
let composedWgsl;
if (matShaderEntry.composedWgsl.includes('\n') || matShaderEntry.composedWgsl.startsWith('struct') || matShaderEntry.composedWgsl.startsWith('//') || matShaderEntry.composedWgsl.startsWith('@')) {
  composedWgsl = matShaderEntry.composedWgsl;
} else {
  const composedWgslPath = resolve(
    appRoot,
    'dist',
    'shaders',
    matShaderEntry.composedWgsl.replace(/^\.\//, ''),
  );
  if (!existsSync(composedWgslPath)) {
    console.error(`[smoke] FAIL - composed wgsl sidecar missing at ${composedWgslPath}`);
    process.exit(1);
  }
  composedWgsl = readFileSync(composedWgslPath, 'utf8');
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
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[hello-custom-shader] backend=${renderer.backend}`);

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const shader = renderer.shader;
const assets = renderer.assets;
if (shader === null || assets === null) {
  console.error('[smoke] FAIL - renderer.shader or renderer.assets is null on dawn path');
  process.exit(1);
}

// Register the user shader entry with the composed wgsl source (as the
// browser app does via `import './pulse-material.wgsl'`).
shader.registerMaterialShader('my-game::pulse-material', {
  source: composedWgsl,
  paramSchema: [
    { name: 'baseColor', type: 'color' },
    { name: 'metallic', type: 'f32' },
    { name: 'roughness', type: 'f32' },
  ],
  bindingLayout: [],
});

const paramValues = {
  baseColor: [0.95, 0.45, 0.2],
  metallic: 0,
  roughness: 2,
};
const world = new World();
const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'my-game::pulse-material',
      tags: { LightMode: 'Forward' },
      queue: 2000,
    },
  ],
  paramValues,
});

const boxRes = createBoxGeometry(1, 1, 1);
if (!boxRes.ok) {
  console.error(`[smoke] FAIL - createBoxGeometry: ${boxRes.error.code}`);
  process.exit(1);
}
const boxMeshHandle = world.allocSharedRef('MeshAsset', boxRes.value);

world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 0.95, 0.9],
    intensity: 1.0,
  },
});

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

// --- 4. Drive 3 t-points + readback ----------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function samplePixelAtT(t) {
  paramValues.metallic = t;
  for (let i = 0; i < SMOKE_FRAMES_PER_T; i++) {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error(`[smoke] draw t=${t} frame ${i} error: ${r.error.code}`);
  }
  await device.queue.onSubmittedWorkDone();
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(0x01);
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  // Sample center pixel of the canvas (where the cube renders).
  const px = Math.floor(WIDTH / 2);
  const py = Math.floor(HEIGHT / 2);
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
}

let framesObserved = 0;
const sampleT0 = await samplePixelAtT(0.0);
framesObserved += SMOKE_FRAMES_PER_T;
const sampleT05 = await samplePixelAtT(0.5);
framesObserved += SMOKE_FRAMES_PER_T;
const sampleT10 = await samplePixelAtT(1.0);
framesObserved += SMOKE_FRAMES_PER_T;

console.log(`[smoke] frames observed=${framesObserved}`);
const pulseSamples = {
  't=0.0': sampleT0,
  't=0.5': sampleT05,
  't=1.0': sampleT10,
};
console.log(`[smoke] pulseSamples=${JSON.stringify(pulseSamples)}`);

const brightness = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;
const b0 = brightness(sampleT0);
const b05 = brightness(sampleT05);
const b10 = brightness(sampleT10);
const delta05 = Math.abs(b05 - b0);
const delta10 = Math.abs(b10 - b0);
console.log(`[smoke] brightnessDelta_05=${delta05.toFixed(4)} delta_10=${delta10.toFixed(4)}`);

// --- 5. Pass-1 verdict (ANTIALIAS_NONE baseline) ---------------------------

const failures = [];
if (renderer.backend !== 'webgpu') {
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
}
if (delta05 < BRIGHTNESS_DELTA_MIN_05) {
  failures.push(
    `(b) |brightness(t=0.5)-brightness(t=0)|=${delta05.toFixed(4)} < threshold=${BRIGHTNESS_DELTA_MIN_05}; pulse not visible at t=0.5s`,
  );
}
if (delta10 < BRIGHTNESS_DELTA_MIN_10) {
  failures.push(
    `(c) |brightness(t=1.0)-brightness(t=0)|=${delta10.toFixed(4)} < threshold=${BRIGHTNESS_DELTA_MIN_10}; pulse not visible at t=1.0s`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL -- Pass-1 (ANTIALIAS_NONE) ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-custom-shader smoke');
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify per-MaterialShader pipeline cache (M9-T03) routes my-game::pulse-material to the user pipeline (not standardPipeline fallback)',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] Pass-1 PASS -- ANTIALIAS_NONE baseline GREEN: backend=webgpu, frames=${framesObserved}, brightnessDelta_05=${delta05.toFixed(4)}>=${BRIGHTNESS_DELTA_MIN_05}, brightnessDelta_10=${delta10.toFixed(4)}>=${BRIGHTNESS_DELTA_MIN_10}, RhiError count=0`,
);

// --- 6. Pass-2: MSAA regression scaffold (bug-20260615 M1 / m1-1) ----------
//
// The pre-fix engine silently substitutes engine PBR for the custom material
// shader whenever Camera.antialias = ANTIALIAS_MSAA. This pass renders two
// worlds under MSAA:
//   - World-B (custom): the pulse-material custom shader with static paramValues
//   - World-C (pbr): a pure PBR material with baseColor matching the custom
//     shader's paramValues.baseColor
//
// Under the bug, both worlds render identically (PBR substitute in both);
// under the fix, the custom world renders through the custom WGSL (sin
// modulation) and the PBR world renders standard PBR — measurably different
// pixel values. The assertion: the two MSAA renders must differ by at least
// a channel delta threshold.
//
// The delta test is a per-channel absolute difference check on the center
// pixel. M3 turns this red→green by removing the !msaaActive dispatch gate.

const MSAA_CUSTOM_VS_PBR_DELTA_MIN = Number.parseFloat(process.env.MSAA_CUSTOM_VS_PBR_DELTA_MIN ?? '0.05');

// --- 6a. Custom-shader world under MSAA ------------------------------------

const msaaCustomParamValues = {
  baseColor: [0.95, 0.45, 0.2],
  metallic: 0,
  roughness: 2,
};
// feat-20260614 M8 (D-17): handles are per-World; mint the custom material into
// worldMsaaCustom via world.allocSharedRef (bare Handle, not a Result).
const worldMsaaCustom = new World();
const msaaCustomMatHandle = worldMsaaCustom.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{
    name: 'Forward',
    shader: 'my-game::pulse-material',
    tags: { LightMode: 'Forward' },
    queue: 2000,
  }],
  paramValues: msaaCustomParamValues,
});
// Mesh handles are per-World too; mint a fresh box handle in this World.
const msaaCustomMeshHandle = worldMsaaCustom.allocSharedRef('MeshAsset', boxRes.value);

worldMsaaCustom
  .spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: msaaCustomMeshHandle } },
    { component: MeshRenderer, data: { materials: [msaaCustomMatHandle] } },
  )
  .unwrap();
worldMsaaCustom.spawn(
  { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100, antialias: ANTIALIAS_MSAA } },
);
worldMsaaCustom.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 0.95, 0.9], intensity: 1.0 },
});

// --- 6b. PBR world under MSAA (same baseColor, no custom shader) -----------

const msaaPbrParamValues = {
  baseColor: [0.95, 0.45, 0.2],
  metallic: 0,
  roughness: 2,
};
// feat-20260614 M8 (D-17): mint the PBR material into worldMsaaPbr (per-World
// handle) via world.allocSharedRef.
const worldMsaaPbr = new World();
const msaaPbrMatHandle = worldMsaaPbr.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{
    name: 'Forward',
    shader: 'forgeax::default-standard-pbr',
    tags: { LightMode: 'Forward' },
    queue: 2000,
  }],
  paramValues: msaaPbrParamValues,
});
// Mesh handles are per-World too; mint a fresh box handle in this World.
const msaaPbrMeshHandle = worldMsaaPbr.allocSharedRef('MeshAsset', boxRes.value);

worldMsaaPbr
  .spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: msaaPbrMeshHandle } },
    { component: MeshRenderer, data: { materials: [msaaPbrMatHandle] } },
  )
  .unwrap();
worldMsaaPbr.spawn(
  { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100, antialias: ANTIALIAS_MSAA } },
);
worldMsaaPbr.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 0.95, 0.9], intensity: 1.0 },
});

// --- 6c. Render both worlds and read back center pixel ---------------------

async function readCenterPixel(world) {
  for (let i = 0; i < SMOKE_FRAMES_PER_T; i++) {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error(`[smoke] Pass-2 draw frame ${i} error: ${r.error.code}`);
  }
  await device.queue.onSubmittedWorkDone();
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
  const px = Math.floor(WIDTH / 2);
  const py = Math.floor(HEIGHT / 2);
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [bytes[off + 0] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0];
}

const customPixel = await readCenterPixel(worldMsaaCustom);
const pbrPixel = await readCenterPixel(worldMsaaPbr);

console.log(`[smoke] Pass-2 customPixel=[${customPixel.join(',')}] pbrPixel=[${pbrPixel.join(',')}]`);

const channelDeltas = [
  Math.abs(customPixel[0] - pbrPixel[0]),
  Math.abs(customPixel[1] - pbrPixel[1]),
  Math.abs(customPixel[2] - pbrPixel[2]),
];
const maxChannelDelta = Math.max(...channelDeltas);
console.log(`[smoke] Pass-2 channelDeltas=${JSON.stringify(channelDeltas)} maxChannelDelta=${maxChannelDelta}`);

const msaaFailures = [];
if (maxChannelDelta < MSAA_CUSTOM_VS_PBR_DELTA_MIN * 255) {
  msaaFailures.push(
    `(e) MSAA custom-vs-PBR max channel delta ${maxChannelDelta} < threshold ${MSAA_CUSTOM_VS_PBR_DELTA_MIN * 255}; ` +
    `under the pre-fix engine, MSAA silently substitutes PBR for the custom shader — both worlds render identically (bug-20260615)`,
  );
}

if (msaaFailures.length > 0) {
  console.error(`[smoke] FAIL -- Pass-2 (ANTIALIAS_MSAA custom vs PBR) ${msaaFailures.length} criteria failed:`);
  for (const f of msaaFailures) console.error(`  ${f}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-custom-shader smoke');
  console.error(
    '  M1 RED scaffold: this is the expected failure under the pre-fix engine. ' +
    'M3 turns this red→green by removing the !msaaActive dispatch gate.',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] Pass-2 PASS -- ANTIALIAS_MSAA custom vs PBR GREEN: maxChannelDelta=${maxChannelDelta} >= threshold=${MSAA_CUSTOM_VS_PBR_DELTA_MIN * 255}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
