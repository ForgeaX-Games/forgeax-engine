// apps/hello/fbx-cube -- feat-20260615-fbx-importer-via-sdk M3 t36 R2 fixup #2.
//
// End-to-end declare-import-load via fbxImporter through the build-time
// vite-plugin-pack pipeline:
//   (1) configurePackIndex('/pack-index.json')      — declared in vite.config.ts
//   (2) createDevImportTransport()                  — dev-server POST /__import/:guid
//                                                     dispatches to fbxImporter
//   (3) loadByGuid<SceneAsset>(sceneGuid)           — runtime resolves the GUID
//                                                     and instantiates
//
// The .fbx fixture lives in forgeax-engine-assets/vendor/fbx-test/ per the
// engine repo's zero-binary invariant. pluginPack scans that directory
// for cube.fbx + cube.fbx.meta.json (see vite.config.ts).
//
// AC-15: this is the full declare-import-load (no registerWithGuid shortcut).

import { createApp } from '@forgeax/engine-app';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  DirectionalLight,
  EngineEnvironmentError,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const PACK_INDEX_URL = '/pack-index.json';
// Scene GUID from forgeax-engine-assets/vendor/fbx-test/cube.fbx.meta.json.
const SCENE_GUID = '019ecd87-179b-773b-8679-4ee436fdd878';

const CLEAR_R = 0.1;
const CLEAR_G = 0.1;
const CLEAR_B = 0.15;
const CLEAR_A = 1.0;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-fbx-cube: missing <canvas id="app">');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[fbx-cube] env:', err);
  else console.error('[fbx-cube] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[fbx-cube] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world: World = app.world;
  const renderer = app.renderer;
  console.warn(`[fbx-cube] backend=${renderer.backend}`);

  const assets = renderer.assets;
  if (assets === null) {
    console.error('[fbx-cube] AssetRegistry is null');
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);

  const sceneGuidRes = AssetGuid.parse(SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[fbx-cube] AssetGuid.parse(scene) failed:', sceneGuidRes.error);
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuidRes.value);
  if (!sceneRes.ok) {
    console.error('[fbx-cube] loadByGuid<SceneAsset> failed:', sceneRes.error);
    return;
  }

  // feat-20260614 M8 (D-17): loadByGuid returns the payload; mint a user-tier
  // column handle for instantiate.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    console.error(
      '[fbx-cube] scene instantiate failed:',
      (instRes.error as { code: string }).code,
    );
    return;
  }
  const root: EntityHandle = instRes.value;

  // Camera + directional light (not in the FBX scene).
  const aspect = target.clientWidth / target.clientHeight;
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 30], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 100 }),
        clearR: CLEAR_R,
        clearG: CLEAR_G,
        clearB: CLEAR_B,
        clearA: CLEAR_A,
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.5,
      directionY: -1,
      directionZ: -0.3,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
    },
  });

  console.warn(`[fbx-cube] cube.fbx scene root entity=${root}`);

  app.start();
}
