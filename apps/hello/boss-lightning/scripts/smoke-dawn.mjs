import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import {
  classifyDawnErrors,
  READINESS_FRAME_LIMIT,
} from './smoke-diagnostics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const distRoot = resolve(appRoot, 'dist');
const WIDTH = 200;
const HEIGHT = 150;
const TARGET_FRAMES = 300;
const SEED = 42;
const CAMERA = { position: [0, 1.2, 7.5], target: [0, 0.8, 0] };
const rerunCmd = 'pnpm --filter @forgeax/hello-boss-lightning smoke';
const falsifier = process.env.BOSS_LIGHTNING_FALSIFY ?? '';

if (!existsSync(resolve(distRoot, 'pack-index.json'))) {
  const build = spawnSync('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const packIndexText = readFileSync(resolve(distRoot, 'pack-index.json'), 'utf8');
const packIndex = JSON.parse(packIndexText);
const packageFiles = new Map(
  packIndex.map(entry => [entry.packageUrl, resolve(distRoot, entry.packageUrl.slice(1))]),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async request => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.pathname === '/pack-index.json') return new Response(packIndexText);
  const file = packageFiles.get(url.pathname);
  if (file !== undefined) return new Response(readFileSync(file));
  const assetFile = resolve(distRoot, url.pathname.slice(1));
  if (existsSync(assetFile)) return new Response(readFileSync(assetFile));
  return originalFetch(request);
};

const shim = await setupGpuShim({ width: WIDTH, height: HEIGHT, rerunCmd });
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const { World, FixedTime } = await import('@forgeax/engine-ecs');
const { mat4 } = await import('@forgeax/engine-math');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { Transform, scenePlugin } = await import('@forgeax/engine-scene');
const {
  createStockParticleCpuExecutorRegistry,
  loadParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleEffectPlayer,
  particleEffectPackLoader,
  particleSimulationPlugin,
} = await import('@forgeax/engine-vfx');
const { particleRenderFeature, particleSceneSpaceResolver } = await import('@forgeax/engine-vfx-render');

const world = new World();
let playerEntity = 0;
let cameraEntity = 0;
const camera = {
  read(currentWorld) {
    const transform = currentWorld.get(cameraEntity, Transform);
    const cameraValue = currentWorld.get(cameraEntity, Camera);
    if (!transform.ok || !cameraValue.ok) return undefined;
    return {
      position: new Float32Array(transform.value.pos),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: mat4.computeViewProj(
        mat4.create(),
        transform.value.pos,
        [0, 0.8, 0],
        [0, 1, 0],
        cameraValue.value.fov,
        cameraValue.value.aspect,
        cameraValue.value.near,
        cameraValue.value.far,
      ),
    };
  },
};
const observations = {
  read(currentWorld) {
    const simulation = currentWorld.getResource(PARTICLE_SIMULATION_RESOURCE_KEY);
    const observation = simulation?.read(playerEntity);
    return observation === undefined ? [] : [observation];
  },
};
const particleFeature = particleRenderFeature({ observations, camera });
const renderer = await createRenderer(
  shim.mockCanvas,
  { features: falsifier === 'strike-only' ? [] : [particleFeature] },
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
);
const errors = [];
let currentFrame = -1;
renderer.onError(error =>
  errors.push({
    code: error.code,
    hint: error.hint,
    detail: error.detail,
    frame: currentFrame,
  }),
);
const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke-dawn] FAIL readiness=${ready.error.code} ${ready.error.hint}`);
  process.exit(1);
}
const assets = renderer.assets;
if (assets === null) throw new Error('AssetRegistry unavailable');
assets.loaders.registerPackLoader(particleEffectPackLoader);
assets.configurePackIndex('/pack-index.json');

const materialGuid = assets.parseGuid('019e9c00-0000-7000-8000-000000000002');
const material = await assets.loadByGuid(materialGuid);
if (!material.ok) throw new Error(`strike material load failed: ${material.error.hint}`);
const strikeMaterial = world.allocSharedRef('MaterialAsset', material.value);
cameraEntity = world.spawn(
  { component: Transform, data: { pos: [0, 1.2, 7.5] } },
  { component: Camera, data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.8, -0.5], color: [0.6, 0.72, 1], intensity: 1.4, castShadow: false },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 1.4, 0], scale: [0.16, 2.8, 0.16] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [strikeMaterial] } },
).unwrap();

const loaded = await loadParticleEffect(assets, '019e9c00-0000-7000-8000-000000000000');
if (!loaded.ok) throw new Error(`particle effect load failed: ${loaded.error.hint}`);
const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
playerEntity = world.spawn(
  { component: Transform, data: { pos: [0, -0.2, 0] } },
  { component: ParticleEffectPlayer, data: { effect, playing: true, seed: SEED, timeScale: 1 } },
).unwrap();
scenePlugin().build(world).unwrap();
particleSimulationPlugin({
  assets,
  cpuExecutors: createStockParticleCpuExecutorRegistry(),
  spaceResolver: particleSceneSpaceResolver({ world }),
}).build(world).unwrap();

const readiness = [];
let firstReadinessFrame;
let bucketCount = 0;
let drawCount = 0;
let particleCount = 0;
for (let frame = 0; frame < TARGET_FRAMES; frame += 1) {
  currentFrame = frame;
  world.update(1 / 60).unwrap();
  const observation = world.getResource(PARTICLE_SIMULATION_RESOURCE_KEY)?.read(playerEntity);
  const batches = observation?.batches.batches ?? [];
  drawCount = batches.length;
  particleCount = batches.reduce((total, batch) => total + batch.count, 0);
  const diagnostics = particleFeature.diagnostics();
  readiness.push(diagnostics.readiness);
  if (firstReadinessFrame === undefined && diagnostics.readiness === 'ready') {
    firstReadinessFrame = frame;
  }
  bucketCount = diagnostics.bucketCount;
  const drawn = renderer.draw([world], { owner: 0 });
  if (!drawn.ok) {
    errors.push({
      code: drawn.error.code,
      hint: drawn.error.hint,
      detail: drawn.error.detail,
      frame: currentFrame,
    });
  }
  await new Promise(resolve => setImmediate(resolve));
  if (firstReadinessFrame === undefined && frame >= READINESS_FRAME_LIMIT) break;
}

if (falsifier === 'strike-only') {
  if (particleCount !== 0 || drawCount !== 0) {
    console.error(`[smoke-dawn] FAIL strike-only emitted particle signal: ${particleCount}`);
    process.exit(1);
  }
  console.error('[smoke-dawn] RED strike-only correctly has no particle signal');
  process.exit(1);
}

const device = shim.sharedDevice;
const target = shim.renderTarget;
if (device === undefined || target === undefined) throw new Error('Dawn render target unavailable');
await device.queue.onSubmittedWorkDone();
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: target },
  { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
  { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const pixels = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();

function zoneEnergy(x0, x1, y0, y1) {
  let energy = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      energy += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / (255 * 3);
    }
  }
  return energy / ((x1 - x0) * (y1 - y0));
}

const billboardZone = { x0: 0, x1: WIDTH / 2, y0: 30, y1: HEIGHT - 20 };
const meshZone = { x0: WIDTH / 2, x1: WIDTH, y0: 30, y1: HEIGHT - 20 };
const billboardEnergy = zoneEnergy(billboardZone.x0, billboardZone.x1, billboardZone.y0, billboardZone.y1);
const meshEnergy = zoneEnergy(meshZone.x0, meshZone.x1, meshZone.y0, meshZone.y1);
const strikeOnly = false;
const recovery = typeof renderer.recover === 'function';
const lastWarmupErrorFrame = errors
  .filter(error => error.code === 'render-feature-preparation-failed')
  .reduce((lastFrame, error) => Math.max(lastFrame, error.frame), -1);
const readinessFrame =
  firstReadinessFrame === undefined
    ? undefined
    : Math.max(firstReadinessFrame, lastWarmupErrorFrame + 1);
const { warmupErrors, persistentErrors } = classifyDawnErrors(errors, readinessFrame);
const result = {
  frames: TARGET_FRAMES,
  seed: SEED,
  camera: CAMERA,
  frame: currentFrame,
  bucketCount,
  drawCount,
  particleCount,
  billboardEnergy,
  meshEnergy,
  billboardZone,
  meshZone,
  readiness: [...new Set(readiness)],
  readinessFrame,
  readinessFrameLimit: READINESS_FRAME_LIMIT,
  recovery,
  strikeOnly,
  errors,
  warmupErrors,
  persistentErrors,
};
globalThis.fetch = originalFetch;
if (
  readinessFrame === undefined ||
  readinessFrame > READINESS_FRAME_LIMIT ||
  persistentErrors.length > 0 ||
  bucketCount < 2 ||
  drawCount < 2 ||
  particleCount === 0
) {
  console.error(`[smoke-dawn] FAIL ${JSON.stringify(result)}`);
  process.exit(1);
}
if (billboardEnergy <= 0 || meshEnergy <= 0) {
  console.error(`[smoke-dawn] FAIL particle pixel zones are empty ${JSON.stringify(result)}`);
  process.exit(1);
}
console.log(`[smoke-dawn] PASS ${JSON.stringify(result)}`);
process.exit(0);
