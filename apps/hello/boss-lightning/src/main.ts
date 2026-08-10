import { createApp } from '@forgeax/engine-app';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { Camera } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform, scenePlugin } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding, type Handle, type MaterialAsset } from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createBossScene, type BossSceneMaterials } from './scene';

const EFFECT_GUID = '019e9c00-0000-7000-8000-000000000000';
const BOSS_BODY_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000003';
const BOSS_ACCENT_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000004';
const GROUND_WARNING_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000005';
const STRIKE_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000002';
const MOUTH_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000001';

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
  const host = createVfxRuntimeHost({ camera: cameraSource() });
  const renderer = await createRenderer(
    target,
    { features: falsifyMode === 'disable-vfx' ? [] : [host.feature] },
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
        return {
          queuedIntents: runtime.snapshot().length,
          diagnostics: runtime.diagnostics(),
          hasPlayer: runtime.hasPlayer(scene.player),
        };
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
