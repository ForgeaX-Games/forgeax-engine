import { createApp } from '@forgeax/engine-app';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { Camera } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform, scenePlugin } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding, type Handle, type MaterialAsset } from '@forgeax/engine-types';
import {
  createVfxEffectContract,
  loadVfxGpuEffect,
  ParticleEffectInstance,
  ParticleEffectPlayer,
  type VfxEffectReflection,
  type VfxGpuEffectAsset,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
  observeStagePlan,
  validatedStagePlan,
} from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createBossScene, type BossSceneMaterials } from './scene';

const EFFECT_GUID = '019e9c00-0000-7000-8000-000000000000';
const BOSS_BODY_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000003';
const BOSS_ACCENT_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000004';
const GROUND_WARNING_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000005';
const STRIKE_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000006';
const MOUTH_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000001';

export type BossLightningValues = {
  readonly intensity: number;
  readonly tint: readonly [number, number, number, number];
};

export function createBossLightningInstance(
  reflection: VfxEffectReflection,
): ParticleEffectInstance<BossLightningValues> {
  const contract = createVfxEffectContract<BossLightningValues>(reflection);
  return new ParticleEffectInstance(contract, {
    initialValues: { intensity: 1, tint: [0.2, 0.5, 1, 1] },
  });
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('boss-lightning: missing canvas');

const validationErrors: Array<{ code: string; hint: string; detail: unknown }> = [];
let cameraReady = false;
let cameraEntity = 0 as EntityHandle;

function cameraSource() {
  return {
    read(world: World) {
      const transform = world.get(cameraEntity, Transform);
      const camera = world.get(cameraEntity, Camera);
      if (!transform.ok || !camera.ok) return undefined;
      cameraReady = true;
      const position = new Float32Array(transform.value.pos);
      return {
        position,
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: mat4.computeViewProj(
          mat4.create(),
          position,
          [0, 0.8, 0],
          [0, 1, 0],
          camera.value.fov,
          camera.value.aspect,
          camera.value.near,
          camera.value.far,
        ),
      };
    },
  };
}

function stageEvidence(
  effect: VfxGpuEffectAsset,
  falsifyMode: string | null,
  active: boolean,
) {
  const stages = effect.program.emitters.flatMap((emitter) => emitter.reflection.stages ?? []);
  const lastKnownGood = validatedStagePlan(stages, 1);
  const candidate = stageCandidatePlan(lastKnownGood, falsifyMode);
  const observation = observeStagePlan(
    candidate,
    falsifyMode?.startsWith('stage-') ? 2 : 1,
    lastKnownGood.ok ? lastKnownGood.value : undefined,
  );
  return {
    stageReadiness: observation.stageReadiness,
    stageOutput: active ? observation.stageOutput : 'empty',
    stageDependencies: lastKnownGood.ok
      ? lastKnownGood.value.stages.map((stage) => ({ id: stage.id, dependsOn: stage.dependsOn }))
      : [],
    stageDispatch: lastKnownGood.ok ? lastKnownGood.value.stages.map((stage) => stage.entryPoint) : [],
    lastKnownGoodStage: observation.lastKnownGoodStage,
  };
}

function stageCandidatePlan(
  lastKnownGood: ReturnType<typeof validatedStagePlan>,
  falsifyMode: string | null,
) {
  if (!lastKnownGood.ok || !falsifyMode?.startsWith('stage-')) return lastKnownGood;
  const source = lastKnownGood.value.stages.map((stage) => ({
    ...stage,
    ...(falsifyMode === 'stage-cycle' ? { dependsOn: [stage.id] } : {}),
    ...(falsifyMode === 'stage-hazard'
      ? { resources: [...stage.resources, ...(stage.resources[0] === undefined ? [] : [stage.resources[0]])] }
      : {}),
    ...(falsifyMode === 'stage-budget' ? { iterationBudget: 65 } : {}),
  }));
  return validatedStagePlan(source, 2);
}

async function loadMaterial(
  world: World,
  assets: NonNullable<Awaited<ReturnType<typeof createRenderer>>['assets']>,
  guid: string,
): Promise<Handle<'MaterialAsset', 'shared'>> {
  const loaded = await assets.loadByGuid<MaterialAsset>(assets.parseGuid(guid));
  if (!loaded.ok) throw new Error(`boss-lightning: material load failed ${guid}: ${loaded.error.hint}`);
  return world.allocSharedRef('MaterialAsset', loaded.value);
}

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const falsifyMode = new URLSearchParams(globalThis.location.search).get('boss-lightning-falsify');
  const world = new World();
  const host = createVfxRuntimeHost({
    camera: cameraSource(),
    providers: [
      createCameraProvider({ available: () => cameraReady }),
      createSceneDepthProvider({ available: () => cameraReady && falsifyMode !== 'missing-depth' }),
    ],
  });
  const renderer = await createRenderer(
    target,
    {
      features:
        falsifyMode === 'disable-vfx' || falsifyMode === 'billboard-fallback'
          ? []
          : [host.feature],
    },
    forgeaxBundlerAdapter(),
  );
  const ready = await renderer.ready;
  if (!ready.ok) throw new Error(`boss-lightning: renderer not ready: ${ready.error.hint}`);
  renderer.onError(error => {
    if (validationErrors.length >= 32) return;
    validationErrors.push({
      code: error.code,
      hint: error.hint,
      detail: 'detail' in error ? error.detail : undefined,
    });
  });
  const assets = renderer.assets;
  if (assets === null) throw new Error('boss-lightning: renderer has no AssetRegistry');
  if (import.meta.env.DEV) {
    assets.configureRuntimeBinding(createStandaloneRuntimeAssetBinding('hello-boss-lightning'));
  } else {
    assets.configurePackIndex('/pack-index.json');
  }
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) throw new Error(`boss-lightning: VFX host attach failed: ${attached.error.hint}`);

  const [body, accent, mouth, groundWarning, strike] = await Promise.all([
    loadMaterial(world, assets, BOSS_BODY_MATERIAL_GUID),
    loadMaterial(world, assets, BOSS_ACCENT_MATERIAL_GUID),
    loadMaterial(world, assets, MOUTH_MATERIAL_GUID),
    loadMaterial(world, assets, GROUND_WARNING_MATERIAL_GUID),
    loadMaterial(world, assets, STRIKE_MATERIAL_GUID),
  ]);
  const materials: BossSceneMaterials = { body, accent, mouth, groundWarning, strike };
  const scene = createBossScene(world, materials);
  cameraEntity = scene.camera;
  const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID);
  if (!loaded.ok) throw new Error(`boss-lightning: GPU effect load failed: ${String(loaded.error)}`);
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
  const appResult = await createApp({ renderer, world, plugins: [scenePlugin()] });
  if (!appResult.ok) throw new Error(`boss-lightning: app assembly failed: ${appResult.error.hint}`);
  appResult.value.start();
  let nextImpactSequence = 1;
  Object.assign(globalThis, {
    __forgeaxBossLightning: {
      app: appResult.value,
      world,
      player: scene.player,
      renderer,
      feature: host.feature,
      effectAsset: loaded.value,
      scene,
      status: () => {
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const eventCounters = runtime.eventCounters(scene.player);
        const stage = stageEvidence(loaded.value, falsifyMode, runtime.hasPlayer(scene.player));
        return {
          queuedIntents: runtime.snapshot().length,
          diagnostics: runtime.diagnostics(),
          hasPlayer: runtime.hasPlayer(scene.player),
          renderFeatureEnabled:
            falsifyMode !== 'disable-vfx' && falsifyMode !== 'billboard-fallback',
          eventCounters,
          gpuLocalEvents: eventCounters.consumed > 0,
          eventQueueCleared: eventCounters.queued === 0,
          dataInterfaceSnapshot: host.dataInterfaces.snapshot,
          ...stage,
        };
      },
      inspect: () => host.inspect(world),
      visualEvidence: () => {
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const status = runtime.eventCounters(scene.player);
        const committed = runtime.lastCommitted(scene.player);
        const stage = stageEvidence(loaded.value, falsifyMode, runtime.hasPlayer(scene.player));
        const renderers = loaded.value.program.emitters.flatMap((emitter) =>
          emitter.renderers.map((renderer) => renderer.kind),
        );
        return {
          expectations: [
            {
              id: 'advanced-renderers-visible',
              observed: `renderers=${renderers.join(',')}`,
              verdict: renderers.includes('ribbon') && renderers.includes('trail') && renderers.includes('beam') ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'live-patch-continuity',
              observed: `generation=${committed?.instanceGeneration ?? 0}`,
              verdict: committed !== undefined && committed.instanceGeneration > 0 ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'event-sub-emitter-visible',
              observed: `consumed=${status.consumed} fanOut=${status.fanOut}`,
              verdict: status.consumed > 0 ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'hmr-last-known-good-visible',
              observed: `stage=${stage.stageOutput} lkg=${stage.lastKnownGoodStage !== undefined}`,
              verdict:
                stage.stageOutput !== 'empty' && stage.lastKnownGoodStage !== undefined
                  ? 'pass'
                  : 'fail',
              confidence: 1,
            },
          ],
        };
      },
      publicApi: {
        create: createBossLightningInstance,
        inspect: () => host.inspect(world),
        recover: () => renderer.recover(),
      },
      submitImpact: () => {
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const instance = runtime.getInstance(scene.player);
        if (falsifyMode !== 'freeze-generation') instance?.patch({ intensity: 1.25 });
        return instance?.submit({
          channel: 'impact',
          payload: { position: [0.25, -0.7, 0], strength: 1 },
          sequence: nextImpactSequence++,
        });
      },
      validationErrors,
      get cameraReady() {
        return cameraReady;
      },
    },
  });
}

void bootstrap(canvas).catch((error: unknown) => {
  console.error('[boss-lightning] bootstrap failed', error);
});
