import { createApp } from '@forgeax/engine-app';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { Camera } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform, scenePlugin } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  loadParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleEffectPlayer,
  particleEffectPackLoader,
  particleSimulationPlugin,
  ParticleSimulation,
  createStockParticleCpuExecutorRegistry,
} from '@forgeax/engine-vfx';
import { particleRenderFeature, particleSceneSpaceResolver } from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createBossScene, type BossSceneMaterials } from './scene';

const BOSS_BODY_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000003';
const BOSS_ACCENT_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000004';
const GROUND_WARNING_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000005';
const STRIKE_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000002';
const MOUTH_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000001';
const PREPARATION_WARMUP_MS = 1000;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('boss-lightning: missing canvas');

const validationErrors: Array<{ code: string; hint: string; detail: unknown }> = [];
const warmupErrors: Array<{ code: string; hint: string; detail: unknown }> = [];
const readinessTransitions: Array<{ readiness: string; bucketCount: number }> = [];
let cameraReady = false;
let previousReadiness: string | undefined;

function observeReadiness(feature: ReturnType<typeof particleRenderFeature>) {
  const diagnostics = feature.diagnostics();
  if (diagnostics.readiness !== previousReadiness) {
    previousReadiness = diagnostics.readiness;
    readinessTransitions.push({
      readiness: diagnostics.readiness,
      bucketCount: diagnostics.bucketCount,
    });
  }
  return diagnostics;
}

function hasNextFrameRecovery(detail: unknown): boolean {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    'recovery' in detail &&
    detail.recovery === 'next-frame'
  );
}

function cameraSource(readCamera: () => EntityHandle) {
  return {
    read(currentWorld: World) {
      const camera = readCamera();
      const transform = currentWorld.get(camera, Transform);
      const cameraValue = currentWorld.get(camera, Camera);
      if (!transform.ok || !cameraValue.ok) return undefined;
      cameraReady = true;
      const position = new Float32Array(transform.value.pos);
      const viewProjection = mat4.computeViewProj(
        mat4.create(),
        position,
        [0, 0.8, 0],
        [0, 1, 0],
        cameraValue.value.fov,
        cameraValue.value.aspect,
        cameraValue.value.near,
        cameraValue.value.far,
      );
      return {
        position,
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection,
      };
    },
  };
}

async function loadMaterial(
  world: World,
  assets: NonNullable<Awaited<ReturnType<typeof createRenderer>>['assets']>,
  guid: string,
): Promise<Handle<'MaterialAsset', 'shared'>> {
  const parsed = assets.parseGuid(guid);
  const loaded = await assets.loadByGuid<MaterialAsset>(parsed);
  if (!loaded.ok) throw new Error(`boss-lightning: material load failed ${guid}: ${loaded.error.hint}`);
  return world.allocSharedRef('MaterialAsset', loaded.value);
}

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const falsifyMode = new URLSearchParams(globalThis.location.search).get('boss-lightning-falsify');
  const world = new World();
  const chargeFeature = particleRenderFeature({
    observations: {
      read(currentWorld) {
        const simulation = currentWorld.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
        const observation = simulation?.read(playerEntity);
        return observation === undefined ? [] : [observation];
      },
    },
    camera: cameraSource(() => cameraEntity),
  });
  const renderer = await createRenderer(
    target,
    { features: [chargeFeature] },
    forgeaxBundlerAdapter(),
  );
  const ready = await renderer.ready;
  if (!ready.ok) throw new Error(`boss-lightning: renderer not ready: ${ready.error.hint}`);
  const warmupStartedAt = performance.now();
  renderer.onError(error => {
    const detail = 'detail' in error ? error.detail : undefined;
    const event = { code: error.code, hint: error.hint, detail };
    if (
      error.code === 'render-feature-preparation-failed' &&
      performance.now() - warmupStartedAt <= PREPARATION_WARMUP_MS &&
      hasNextFrameRecovery(detail)
    ) {
      warmupErrors.push(event);
      return;
    }
    validationErrors.push(event);
  });
  const assets = renderer.assets;
  if (assets === null) throw new Error('boss-lightning: renderer has no AssetRegistry');
  assets.loaders.registerPackLoader(particleEffectPackLoader);
  assets.configurePackIndex('/pack-index.json');

  const [body, accent, mouth, groundWarning, strike] = await Promise.all([
    loadMaterial(world, assets, BOSS_BODY_MATERIAL_GUID),
    loadMaterial(world, assets, BOSS_ACCENT_MATERIAL_GUID),
    loadMaterial(world, assets, MOUTH_MATERIAL_GUID),
    loadMaterial(world, assets, GROUND_WARNING_MATERIAL_GUID),
    loadMaterial(world, assets, STRIKE_MATERIAL_GUID),
  ]);
  const materials: BossSceneMaterials = { body, accent, mouth, groundWarning, strike };
  const scene = createBossScene(world, materials);
  playerEntity = scene.player;
  cameraEntity = scene.camera;
  const resolver = particleSceneSpaceResolver({
    world,
    resolveJoint: () => scene.mouthJoint,
  });
  const loaded = await loadParticleEffect(assets, '019e9c00-0000-7000-8000-000000000000');
  if (!loaded.ok) throw new Error(`boss-lightning: effect load failed: ${loaded.error.hint}`);
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  world.addComponent(scene.player, {
    component: ParticleEffectPlayer,
    data: {
      effect,
      playing: falsifyMode !== 'emitter-zero' && falsifyMode !== 'material-empty',
      seed: 42,
      timeScale: 1,
    },
  }).unwrap();
  const appResult = await createApp({
    renderer,
    world,
    plugins: [
      scenePlugin(),
      particleSimulationPlugin({
        assets,
        cpuExecutors: createStockParticleCpuExecutorRegistry(),
        spaceResolver: resolver,
      }),
    ],
  });
  if (!appResult.ok) throw new Error(`boss-lightning: app assembly failed: ${appResult.error.hint}`);
  appResult.value.start();
  Object.assign(globalThis, {
    __forgeaxBossLightning: {
      app: appResult.value,
      world,
      player: scene.player,
      renderer,
      feature: chargeFeature,
      scene,
      status: () => observeReadiness(chargeFeature),
      validationErrors,
      warmupErrors,
      readinessTransitions,
      get cameraReady() {
        return cameraReady;
      },
    },
  });
}

let playerEntity = 0 as EntityHandle;
let cameraEntity = 0 as EntityHandle;
void bootstrap(canvas).catch((error: unknown) => {
  console.error('[boss-lightning] bootstrap failed', error);
});
