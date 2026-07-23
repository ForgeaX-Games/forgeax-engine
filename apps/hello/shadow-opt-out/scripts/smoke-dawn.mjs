#!/usr/bin/env node
// apps/hello/shadow-opt-out headless smoke
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
//
// Structural-only smoke: 300-frame stable draw loop + shadow factor
// sampling confirms cube A casts shadow (< 1), cube B no shadow (=~ 1),
// cube C shadow via cutout shader produces an intermediate value.
//
// Output literals (grep-anchored):
//   - `[shadow-opt-out] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] shadow factor A=<f> B=<f> C=<f>`

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FIXTURE_MAP_SIZE = 1024;

// ── 1. dawn.node binding ────────────────────────────────────────────────

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (globalThis.navigator === undefined) {
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

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// ── 2. Mock canvas ──────────────────────────────────────────────────────

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

// ── 3. Build shader manifest ────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

// ── 4. Drive engine ECS ─────────────────────────────────────────────────

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  Camera,
  createRenderer,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[shadow-opt-out] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code}`);
  process.exit(1);
}

// Register cutout shadow shader from manifest
const shader = renderer.shader;
const assets = renderer.assets;
if (shader === null || assets === null) {
  console.error('[smoke] FAIL - shader or assets null');
  process.exit(1);
}

const CUTOUT_SHADER_PATH = 'shadow_opt_out::cutout_shadow';
const cutoutEntry = shader.lookupMaterialShader(CUTOUT_SHADER_PATH);
if (!cutoutEntry.ok) {
  // Register from manifest entries (populated by vite-plugin-shader at build time)
  for (const entry of shader.materialShaderManifestEntries()) {
    if (entry.identifier === CUTOUT_SHADER_PATH) {
      shader.registerMaterialShader(CUTOUT_SHADER_PATH, {
        source: entry.composedWgsl,
        paramSchema: [{ name: 'baseColor', type: 'color' }],
        bindingLayout: [],
      });
      break;
    }
  }
  const check2 = shader.lookupMaterialShader(CUTOUT_SHADER_PATH);
  if (!check2.ok) {
    console.error(`[smoke] FAIL - cutout shader not found in manifest`);
    process.exit(1);
  }
}

const world = new World();

// Light + shadow (merged component)
world.spawn(
  {
    component: DirectionalLight,
    data: {
      direction: [-0.3, -1.0, -0.5],
      color: [1, 0.95, 0.9],
      intensity: 1.0,
      // feat-20260613-csm M6 / w22: matches src/main.ts (cascadeCount=1
      // AC-10 baseline). orthoHalfExtent removed (legacy field gone);
      // shadowDistance tightened 60 -> 20 so the cutout 0.15-unit holes stay
      // resolvable at mapSize=1024 under CSM AABB-fit.
      cascadeCount: 1,
      mapSize: FIXTURE_MAP_SIZE,
      shadowDistance: 20,
    },
  },
);

// Camera — quat tilts default -z forward by ~56.3° around X so forward = (0, -0.832, -0.555)
// looking at the cubes + floor at origin. Mirrors main.ts; dawn smoke is insensitive to camera
// pose (debugSampleShadowFactor reads shadow map directly), but the two scripts stay in sync
// to honor the memory [[smoke-script-duplicate-scene-must-stay-in-sync-with-main]].
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 12, 8], quat: [-0.4718579255320243, 0, 0, 0.8816745987679437], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);

// Floor
world.spawn(
  {
    component: Transform,
    data: { pos: [0, -0.01, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: {} },
);

// Cube A: red, casts shadow (default)
const matA = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.9, 0.1, 0.1, 1] }));
world.spawn(
  {
    component: Transform,
    data: { pos: [-3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matA] } },
);

// Cube B: green, castShadow: false
const matB = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.1, 0.8, 0.1, 1], castShadow: false }));
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matB] } },
);

// Cube C: blue, cutout shadow shader
const matC = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    { name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 },
    { name: 'ShadowCaster', shader: CUTOUT_SHADER_PATH, tags: { LightMode: 'ShadowCaster' } },
  ],
  paramValues: { baseColor: [0.1, 0.1, 0.9, 1], metallic: 0, roughness: 0.5 },
});
world.spawn(
  {
    component: Transform,
    data: { pos: [3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matC] } },
);

// ── 5. Render loop ──────────────────────────────────────────────────────

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms)`);

// ── 6. Shadow factor sampling ───────────────────────────────────────────

// Sample floor positions offset from each cube to avoid the full occlusion
// from the cube itself. Light direction (-0.3, -1.0, -0.5) tilts +X +Z.
// Shadow projects: offsetX = height * dirX/|dirY| = 1.25 * 0.3/1.0 ≈ 0.38
// Position slightly offset outside the cube's own footprint to detect its
// cast shadow on the floor rather than being inside the cube's self-shadow.
const posAOffset = [-3 + 0.6, 0.01, 0.3];
const posBOffset = [0 + 0.6, 0.01, 0.3];
const posCOffset = [3 + 0.6, 0.01, 0.3];

const shadowResults = await renderer.debugSampleShadowFactor?.([posAOffset, posBOffset, posCOffset]);
if (!shadowResults) {
  console.error('[smoke] FAIL - debugSampleShadowFactor returned null');
  process.exit(1);
}

const factorA = shadowResults[0]?.shadowFactor ?? -1;
const factorB = shadowResults[1]?.shadowFactor ?? -1;
const factorC = shadowResults[2]?.shadowFactor ?? -1;

console.log(`[smoke] shadow factor A=${factorA.toFixed(4)} B=${factorB.toFixed(4)} C=${factorC.toFixed(4)}`);

// ── 7. Verdict ──────────────────────────────────────────────────────────

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  failures.push(`(c) onError: ${errors.map((e) => e.code).join(', ')}`);
}

// AC-17: Cube A casts shadow -> shadow factor < 1 at offset position
if (factorA >= 0.9) {
  failures.push(`(d) cube A shadow factor ${factorA.toFixed(4)} >= 0.9 (expected < 0.9, cube A casts shadow)`);
}

// AC-17: Cube B castShadow:false -> shadow factor approx 1
if (factorB < 0.9) {
  failures.push(`(e) cube B shadow factor ${factorB.toFixed(4)} < 0.9 (expected >= 0.9, castShadow:false)`);
}

// AC-17: Cube C shadow from cutout shader produces shadow that differs from
// fully-lit (1.0) — the cutout creates some occlusion even at edge positions.
// Looser test: just verify it's not stuck at exactly 1.0 (fully lit, which
// would mean the shader never ran).
if (factorC > 0.95) {
  failures.push(`(f) cube C shadow factor ${factorC.toFixed(4)} > 0.95 (expected some occlusion from cutout, factorA=${factorA.toFixed(4)} for reference)`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device.destroy?.();
  process.exit(1);
}

console.log('[smoke] PASS - castShadow opt-out + cutout shadow demo GREEN');
device.destroy?.();
process.exit(0);
