import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { classifyDawnErrors, READINESS_FRAME_LIMIT } from './smoke-diagnostics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const distRoot = resolve(appRoot, 'dist');
const WIDTH = 200;
const HEIGHT = 150;
const benchmarkCapacity = Number.parseInt(process.env.VFX_BENCH_CAPACITY ?? '', 10);
const benchmarkMode = Number.isFinite(benchmarkCapacity) && benchmarkCapacity > 0;
const benchmarkAdapterClass = /(?:^|\/)lvp(?:_|\.)/.test(
  process.env.VK_ICD_FILENAMES ?? process.env.VK_DRIVER_FILES ?? '',
)
  ? 'software-reference'
  : 'hardware';
const TARGET_FRAMES = 300;
const frameLimit = benchmarkMode ? 90 : TARGET_FRAMES;
const SEED = 42;
const CAMERA = { position: [0, 1.2, 7.5], target: [0, 0.8, 0] };
const rerunCmd = 'pnpm --filter @forgeax/hello-boss-lightning smoke';
const falsifier = process.env.BOSS_LIGHTNING_FALSIFY ?? '';
const m11Mode = process.env.BOSS_LIGHTNING_M11 === '1';
const eventScenario = 'event-sub-emitter';
const eventOverflow = 'overflow';
const missingDepth = 'missing-depth';
const requiredStageId = 'turbulence';
const advancedRendererFields = ['textureSheet', 'pivot', 'softParticle', 'sorting', 'ribbon', 'trail', 'beam'];

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
const manifest = JSON.parse(readFileSync(resolve(distRoot, 'shaders/manifest.json'), 'utf8'));
const { World } = await import('@forgeax/engine-ecs');
const { mat4 } = await import('@forgeax/engine-math');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { Transform, scenePlugin } = await import('@forgeax/engine-scene');
const {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
} = await import('@forgeax/engine-vfx');
const {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
  observeStagePlan,
  validatedStagePlan,
} = await import('@forgeax/engine-vfx-render');

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
const host = createVfxRuntimeHost({
  camera,
  providers: [
    createCameraProvider({ available: () => true }),
    createSceneDepthProvider({ available: () => falsifier !== missingDepth }),
  ],
});
const renderer = await createRenderer(
  shim.mockCanvas,
  { features: falsifier === 'strike-only' ? [] : [host.feature] },
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
const attachment = renderer.attachWorld(world);
if (!attachment.ok) throw attachment.error;
const assets = renderer.assets;
if (assets === null) throw new Error('AssetRegistry unavailable');
assets.configurePackIndex('/pack-index.json');
const attached = await host.attachWorld({ world, assets });
if (!attached.ok) throw new Error(`VFX host attach failed: ${attached.error.hint}`);

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

const loaded = await loadVfxGpuEffect(assets, '019e9c00-0000-7000-8000-000000000000');
if (!loaded.ok) throw new Error(`particle effect load failed: ${loaded.error.code}: ${loaded.error.hint}`);
let benchmarkAllocatedCapacity = 0;
if (benchmarkMode) {
  const emitterCount = loaded.value.program.emitters.length;
  const baseCapacity = Math.floor(benchmarkCapacity / emitterCount);
  const remainder = benchmarkCapacity % emitterCount;
  loaded.value.program.emitters.forEach((emitter, index) => {
    emitter.capacity = baseCapacity + (index < remainder ? 1 : 0);
    benchmarkAllocatedCapacity += emitter.capacity;
  });
}
const stageReflection = loaded.value.program.emitters.flatMap(item => item.reflection.stages ?? []);
const lastKnownGoodPlan = validatedStagePlan(stageReflection, 1);
let stageCandidate = lastKnownGoodPlan;
if (lastKnownGoodPlan.ok && falsifier.startsWith('stage-')) {
  const source = lastKnownGoodPlan.value.stages.map(stage => ({
    ...stage,
    ...(falsifier === 'stage-cycle' ? { dependsOn: [stage.id] } : {}),
    ...(falsifier === 'stage-hazard'
      ? { resources: [...stage.resources, ...(stage.resources[0] === undefined ? [] : [stage.resources[0]])] }
      : {}),
    ...(falsifier === 'stage-budget' ? { iterationBudget: 65 } : {}),
  }));
  stageCandidate = validatedStagePlan(source, 2);
}
const stageObservation = observeStagePlan(
  stageCandidate,
  falsifier.startsWith('stage-') ? 2 : 1,
  lastKnownGoodPlan.ok ? lastKnownGoodPlan.value : undefined,
);
const softParticle = loaded.value.program.emitters.some(item =>
  item.reflection.dataInterfaces?.some(interfaceValue => interfaceValue.kind === 'scene-depth'),
);
const depthProviderReady = host.resolveDataInterfaces({
  requirements: [
    {
      token: 'vfx:scene-depth',
      kind: 'scene-depth',
      binding: 9,
      bindingType: 'sampled-depth',
      lifetime: 'generation',
    },
  ],
  generation: 1,
});
if (!depthProviderReady.ok) {
  if (falsifier === missingDepth) {
    console.error(`[smoke-dawn] RED ${missingDepth} exposed ${depthProviderReady.error.code}`);
    process.exit(1);
  }
  throw new Error(`scene-depth provider failed: ${depthProviderReady.error.hint}`);
}
const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
playerEntity = world.spawn(
  { component: Transform, data: { pos: [0, -0.2, 0] } },
  { component: ParticleEffectPlayer, data: { effect, playing: true, seed: SEED, timeScale: 1 } },
).unwrap();
const topologyShowcases = [
  { kind: 'ribbon', x: -2.2 },
  { kind: 'trail', x: 0 },
  { kind: 'beam', x: 2.2 },
];
const sourceEmitter = loaded.value.program.emitters[0];
for (const showcase of benchmarkMode ? [] : topologyShowcases) {
  const showcaseEmitter = {
    ...sourceEmitter,
    id: `showcase-${showcase.kind}`,
    space: 'local',
    channels: [],
    events: [],
    renderers: sourceEmitter.renderers.filter(rendererValue => rendererValue.kind === showcase.kind),
  };
  const showcaseEffect = {
    ...loaded.value,
    program: {
      ...loaded.value.program,
      fingerprint: `${loaded.value.program.fingerprint}:${showcase.kind}`,
      emitters: [showcaseEmitter],
    },
  };
  const showcaseHandle = world.allocSharedRef('ParticleEffectAsset', showcaseEffect);
  world.spawn(
    { component: Transform, data: { pos: [showcase.x, -0.8, 0] } },
    {
      component: ParticleEffectPlayer,
      data: { effect: showcaseHandle, playing: true, seed: SEED, timeScale: 1 },
    },
  ).unwrap();
}
scenePlugin().build(world).unwrap();

const readiness = [];
let firstReadinessFrame;
let queuedIntents = 0;
let runtimeDiagnostics = [];
let eventDispatch = false;
let subEmitterVisible = false;
let queueCleared = false;
let mainEffectRunning = false;
let lastCommitted;
let eventSubmitted = false;
const runtime = world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
const frameDurations = [];
for (let frame = 0; frame < frameLimit; frame += 1) {
  const frameStart = performance.now();
  currentFrame = frame;
  world.update(1 / 60).unwrap();
  if (!eventSubmitted) {
    const instance = runtime?.getInstance(playerEntity);
    instance?.submit({
      channel: 'impact',
      payload: { position: [0.25, -0.7, 0], strength: 1 },
      sequence: 1,
    });
    eventSubmitted = true;
  }
  const drawn = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
  if (!drawn.ok) {
    errors.push({
      code: drawn.error.code,
      hint: drawn.error.hint,
      detail: drawn.error.detail,
      frame: currentFrame,
    });
  }
  await new Promise(resolve => setImmediate(resolve));
  if (benchmarkMode) {
    await shim.sharedDevice?.queue.onSubmittedWorkDone();
    if (frame >= 30) frameDurations.push(performance.now() - frameStart);
  }
  queuedIntents = runtime.snapshot().length;
  runtimeDiagnostics = runtime.diagnostics();
  const eventCounters = runtime.eventCounters(playerEntity);
  eventDispatch = eventCounters.produced > 0;
  subEmitterVisible = eventCounters.consumed > 0;
  queueCleared = eventCounters.queued === 0;
  mainEffectRunning = runtime.hasPlayer(playerEntity);
  lastCommitted = runtime.lastCommitted(playerEntity);
  const readyNow = runtime.hasPlayer(playerEntity) && queuedIntents === 0 && runtimeDiagnostics.length === 0;
  readiness.push(readyNow ? 'ready' : 'warming');
  if (firstReadinessFrame === undefined && readyNow) firstReadinessFrame = frame;
  if (firstReadinessFrame === undefined && frame >= READINESS_FRAME_LIMIT) break;
}

let m11Recovery;
if (m11Mode) {
  const stale = runtime.getInstance(playerEntity);
  const renderGenerationBefore = runtime.renderGeneration;
  const featureRecovery = host.feature.recover();
  const stalePatch = stale?.patch({});
  world.update(1 / 60).unwrap();
  const restarted = runtime.getInstance(playerEntity);
  const restartedInspect = runtime.inspectPlayer(playerEntity);
  const currentPatch = restarted?.patch({});
  world.update(1 / 60).unwrap();
  const currentInspect = runtime.inspectPlayer(playerEntity);
  for (let recoveryFrame = 0; recoveryFrame < 10; recoveryFrame += 1) {
    currentFrame += 1;
    world.update(1 / 60).unwrap();
    const recoveredDraw = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!recoveredDraw.ok) {
      errors.push({
        code: recoveredDraw.error.code,
        hint: recoveredDraw.error.hint,
        detail: recoveredDraw.error.detail,
        frame: currentFrame,
      });
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  queuedIntents = runtime.snapshot().length;
  runtimeDiagnostics = runtime.diagnostics();
  lastCommitted = runtime.lastCommitted(playerEntity);
  m11Recovery = {
    featureRecovery,
    renderGenerationBefore,
    renderGenerationAfter: runtime.renderGeneration,
    stalePatch,
    staleInstanceDetached: stale !== undefined && restarted !== stale,
    restartedGeneration: restartedInspect?.values.generation ?? null,
    currentPatch,
    currentGeneration: currentInspect?.values.generation ?? null,
  };
  if (
    !featureRecovery.ok ||
    runtime.renderGeneration !== renderGenerationBefore + 1 ||
    !m11Recovery.staleInstanceDetached ||
    restartedInspect?.values.generation !== 0 ||
    currentInspect?.values.generation !== 1 ||
    queuedIntents !== 0 ||
    runtimeDiagnostics.length !== 0
  ) {
    console.error(`[smoke-dawn] FAIL M11 generation fence ${JSON.stringify(m11Recovery)}`);
    process.exit(1);
  }
  console.log(`[m11-vfx] Dawn generation fence: PASS ${JSON.stringify(m11Recovery)}`);
}

if (falsifier === 'strike-only') {
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

function topologyPixelEvidence() {
  const counts = { ribbon: 0, trail: 0, beam: 0 };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      if (blue > 0.45 && green > red * 1.35) counts.ribbon += 1;
      if (red > 0.45 && red > green * 1.1 && green > blue * 1.25) counts.trail += 1;
      if (blue > 0.45 && red > green * 1.35 && blue > green * 1.35) counts.beam += 1;
    }
  }
  return counts;
}

const billboardZone = { x0: 0, x1: WIDTH / 2, y0: 30, y1: HEIGHT - 20 };
const meshZone = { x0: WIDTH / 2, x1: WIDTH, y0: 30, y1: HEIGHT - 20 };
const billboardEnergy = zoneEnergy(billboardZone.x0, billboardZone.x1, billboardZone.y0, billboardZone.y1);
const meshEnergy = zoneEnergy(meshZone.x0, meshZone.x1, meshZone.y0, meshZone.y1);
const topologyPixels = topologyPixelEvidence();
const sortedFrameDurations = [...frameDurations].sort((left, right) => left - right);
const durationPercentile = percentile =>
  sortedFrameDurations[Math.max(0, Math.ceil(sortedFrameDurations.length * percentile) - 1)] ?? 0;
const topologyZones = {
  ribbon: zoneEnergy(25, 80, 75, 145),
  trail: zoneEnergy(75, 125, 75, 145),
  beam: zoneEnergy(125, 180, 75, 145),
};
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
  frames: frameLimit,
  seed: SEED,
  camera: CAMERA,
  frame: currentFrame,
  queuedIntents,
  runtimeDiagnostics,
  lastCommitted: lastCommitted === undefined ? undefined : {
    tick: lastCommitted.tick,
    generation: lastCommitted.instanceGeneration,
    patchCount: lastCommitted.instancePatchCount,
    canonicalPayload: [...lastCommitted.canonicalPayload],
    replay: {
      seed: lastCommitted.replayInput.seed,
      tick: lastCommitted.replayInput.tick,
      generation: lastCommitted.replayInput.generation,
      sequence: lastCommitted.replayInput.sequence,
      payload: [...lastCommitted.replayInput.payload],
    },
  },
  billboardEnergy,
  meshEnergy,
  topologyPixels,
  ...(benchmarkMode
    ? {
        benchmark: {
          backend: 'dawn-wgpu',
          adapterClass: benchmarkAdapterClass,
          capacity: benchmarkCapacity,
          allocatedCapacity: benchmarkAllocatedCapacity,
          warmupFrames: 30,
          samples: frameDurations.length,
          p50Ms: durationPercentile(0.5),
          p95Ms: durationPercentile(0.95),
          p99Ms: durationPercentile(0.99),
        },
      }
    : {}),
  topologyZones,
  advancedRendererFields,
  topologyCounters: Object.fromEntries(
    loaded.value.program.emitters
      .flatMap(item => item.renderers)
      .map(rendererValue => [rendererValue.kind, { capacity: rendererValue.capacity ?? 0, produced: 0, dropped: 0 }]),
  ),
  indirectDraws: loaded.value.program.emitters
    .flatMap(item => item.renderers)
    .map(rendererValue => rendererValue.kind),
  billboardZone,
  meshZone,
  readiness: [...new Set(readiness)],
  readinessFrame,
  readinessFrameLimit: READINESS_FRAME_LIMIT,
  recovery,
  ...(m11Recovery === undefined ? {} : { m11Recovery }),
  strikeOnly,
  errors,
  warmupErrors,
  persistentErrors,
  depthProviderReady: depthProviderReady.value.readiness === 'ready',
  softParticle,
  eventScenario,
  eventOverflow,
  eventDispatch,
  subEmitterVisible,
  queueCleared,
  mainEffectRunning,
  arcNovaLayerRunning: loaded.value.program.emitters.filter(item => item.id.startsWith('charge-') || item.id.startsWith('release-') || item.id.startsWith('decay-') || item.id.startsWith('impact-violet') || item.id.startsWith('impact-cross')).length === 8,
  stageReadiness: stageObservation.stageReadiness,
  stageOutput: stageObservation.stageOutput,
  stageDependencies: lastKnownGoodPlan.ok
    ? lastKnownGoodPlan.value.stages.map(stage => ({ id: stage.id, dependsOn: stage.dependsOn }))
    : [],
  stageDispatch: lastKnownGoodPlan.ok
    ? lastKnownGoodPlan.value.stages.map(stage => stage.entryPoint)
    : [],
  lastKnownGoodStage: stageObservation.lastKnownGoodStage,
};
globalThis.fetch = originalFetch;
if (
  readinessFrame === undefined ||
  readinessFrame > READINESS_FRAME_LIMIT ||
  persistentErrors.length > 0 ||
  queuedIntents !== 0 ||
  runtimeDiagnostics.length > 0
) {
  console.error(`[smoke-dawn] FAIL ${JSON.stringify(result)}`);
  process.exit(1);
}
if (billboardEnergy <= 0 || meshEnergy <= 0) {
  console.error(`[smoke-dawn] FAIL particle pixel zones are empty ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!benchmarkMode && falsifier.length === 0 && !result.arcNovaLayerRunning) {
  console.error(`[smoke-dawn] FAIL Arc Nova GPU layer is not running ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!['ribbon', 'trail', 'beam'].every(kind => result.indirectDraws.includes(kind))) {
  console.error(`[smoke-dawn] FAIL independent topology evidence is missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (Object.values(topologyPixels).some(count => count < 20)) {
  console.error(`[smoke-dawn] FAIL advanced topology pixels are missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!depthProviderReady.value || !softParticle) {
  console.error(`[smoke-dawn] FAIL soft-particle Data Interface was not consumed ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  result.stageOutput === 'empty' ||
  result.stageDispatch.length === 0 ||
  result.stageDependencies.length === 0 ||
  result.lastKnownGoodStage === undefined ||
  !result.stageReadiness.some(item => item.id === requiredStageId)
) {
  console.error(`[smoke-dawn] FAIL managed stage evidence missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  falsifier.startsWith('stage-') &&
  (result.stageOutput !== 'last-known-good' ||
    !result.stageReadiness.some(item => item.state === 'candidate-rejected' && item.retryable))
) {
  console.error(`[smoke-dawn] FAIL stage falsifier did not retain LKG ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  lastCommitted === undefined ||
  lastCommitted.instanceGeneration !== lastCommitted.replayInput.generation ||
  JSON.stringify([...lastCommitted.canonicalPayload]) !==
    JSON.stringify([...lastCommitted.replayInput.payload])
) {
  console.error(`[smoke-dawn] FAIL non-canonical replay record ${JSON.stringify(result)}`);
  process.exit(1);
}
console.log(`[smoke-dawn] PASS ${JSON.stringify(result)}`);
process.exit(0);
