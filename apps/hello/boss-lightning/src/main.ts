import { configureRuntimeAssetCatalog, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app';
import { createWorldContext, World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { Context } from '@forgeax/engine-plugin';
import { Camera, type RenderWorldLease } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform, scenePlugin } from '@forgeax/engine-scene';
import { type Handle, type MaterialAsset } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
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
const cameraEntities = new WeakMap<World, EntityHandle>();

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
      const owner = cameraEntities.get(world) ?? cameraEntity;
      const transform = world.get(owner, Transform);
      const camera = world.get(owner, Camera);
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
  assets: AssetRegistry,
  guid: string,
): Promise<Handle<'MaterialAsset', 'shared'>> {
  const loaded = await assets.loadByGuid<MaterialAsset>(assets.parseGuid(guid));
  if (!loaded.ok) throw new Error(`boss-lightning: material load failed ${guid}: ${loaded.error.hint}`);
  return world.allocSharedRef('MaterialAsset', loaded.value);
}

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const searchParams = new URLSearchParams(globalThis.location.search);
  const falsifyMode = searchParams.get('boss-lightning-falsify');
  const m35Mode = searchParams.get('boss-lightning-m35') === '1';
  const world = new World();
  const host = createVfxRuntimeHost({
    camera: cameraSource(),
    ...(m35Mode ? { maxQueuedTicks: 1 } : {}),
    providers: [
      createCameraProvider({ available: () => cameraReady }),
      createSceneDepthProvider({ available: () => cameraReady && falsifyMode !== 'missing-depth' }),
    ],
  });
  const constructed = await constructRuntimeRendererHost(
    target,
    {
      features:
        falsifyMode === 'disable-vfx' || falsifyMode === 'billboard-fallback'
          ? []
          : [host.feature],
    },
    forgeaxBundlerAdapter(),
  );
  if (!constructed.ok) throw constructed.error;
  const renderer = constructed.value.renderer;
  const assets = constructed.value.assets;
  const attachedMainRendererWorld = renderer.attach(world);
  if (!attachedMainRendererWorld.ok) throw attachedMainRendererWorld.error;
  const mainLease = attachedMainRendererWorld.value;
  renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    const error = event.error;
    if (validationErrors.length >= 32) return;
    validationErrors.push({
      code: error.code,
      hint: error.hint,
      detail: 'detail' in error ? error.detail : undefined,
    });
  });
  configureRuntimeAssetCatalog(
    assets,
    runtimeBinding,
  );
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
  cameraEntities.set(world, cameraEntity);
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
  let m35World: World | undefined;
  let m35Player: EntityHandle | undefined;
  let m35Context: Context | undefined;
  let m35Lease: RenderWorldLease | undefined;
  if (m35Mode) {
    m35World = new World();
    const m35Camera = m35World
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 7.5] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: target.width / target.height, near: 0.1, far: 100 },
        },
      )
      .unwrap();
    cameraEntities.set(m35World, m35Camera);
    const m35Effect = m35World.allocSharedRef('ParticleEffectAsset', loaded.value);
    m35Player = m35World
      .spawn(
        { component: Transform, data: { pos: [0, -0.2, 0] } },
        {
          component: ParticleEffectPlayer,
          data: { effect: m35Effect, playing: true, seed: 43, timeScale: 1 },
        },
      )
      .unwrap();
    m35Context = await createWorldContext(m35World, [scenePlugin()]);
    const attachedM35RendererWorld = renderer.attach(m35World);
    if (!attachedM35RendererWorld.ok) throw attachedM35RendererWorld.error;
    m35Lease = attachedM35RendererWorld.value;
    const attachedM35HostWorld = await host.attachWorld({ world: m35World, assets });
    if (!attachedM35HostWorld.ok) {
      throw new Error(`boss-lightning: M35 VFX host attach failed: ${attachedM35HostWorld.error.hint}`);
    }
  }
  const appResult = await createApp({ renderer, assets, world, plugins: [scenePlugin()] });
  if (!appResult.ok) throw new Error(`boss-lightning: app assembly failed: ${appResult.error.hint}`);
  appResult.value.start();
  let nextImpactSequence = 1;
  const m35 =
    m35World === undefined || m35Player === undefined
      ? undefined
      : {
          world: m35World,
          player: m35Player,
          pause: () => appResult.value.pause(),
          resume: () => appResult.value.resume(),
          inspect: () => ({ affected: host.inspect(m35World), sibling: host.inspect(world) }),
          control: () => host.acquireControl(m35World),
          step: () => {
            const siblingUpdate = world.update(1 / 60);
            const affectedUpdate = m35World.update(1 / 60);
            if (!siblingUpdate.ok || !affectedUpdate.ok) {
              return { siblingUpdate, affectedUpdate, draw: undefined };
            }
            if (m35Lease === undefined) throw new Error('boss-lightning: M35 render lease unavailable');
            const draw = renderer.draw({
              leases: [mainLease, m35Lease],
              camera: { lease: mainLease },
              environment: { lease: mainLease },
            });
            return { siblingUpdate, affectedUpdate, draw };
          },
          cleanup: async () => {
            const stopped = appResult.value.stop();
            await m35Context?.fiber.dispose();
            await appResult.value.dispose();
            const detachAffected = await host.detachWorld({ world: m35World });
            const detachAffectedAgain = await host.detachWorld({ world: m35World });
            const detachSibling = await host.detachWorld({ world });
            const detachSiblingAgain = await host.detachWorld({ world });
            m35Lease?.dispose();
            mainLease.dispose();
            await renderer.dispose();
            await renderer.dispose();
            return {
              stopped,
              detachAffected,
              detachAffectedAgain,
              detachSibling,
              detachSiblingAgain,
              rendererDisposedTwice: true,
            };
          },
        };
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
          renderGeneration: runtime.renderGeneration,
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
        ...(m35 === undefined
          ? {}
          : {
              replay: () => {
                const control = host.acquireControl(m35.world);
                return control.ok ? control.value.replay({ player: m35.player }) : control;
              },
            }),
      },
      m35,
      m11: {
        holdStaleInstance: () => {
          const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
          const instance = runtime.getInstance(scene.player);
          Object.assign(globalThis, { __forgeaxBossLightningM11Stale: instance });
          return instance === undefined ? { ok: false, reason: 'instance-unavailable' } : { ok: true };
        },
        patchStaleInstance: () => {
          const instance = (globalThis as typeof globalThis & {
            __forgeaxBossLightningM11Stale?: ParticleEffectInstance;
          }).__forgeaxBossLightningM11Stale;
          return instance?.patch({ intensity: 1.75 });
        },
        patchCurrentInstance: () => {
          const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
          return runtime.getInstance(scene.player)?.patch({ intensity: 1.5 });
        },
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
