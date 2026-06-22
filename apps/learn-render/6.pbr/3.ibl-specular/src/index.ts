// apps/learn-render/6.pbr/3.ibl-specular/src/index.ts
// LearnOpenGL section 6.2 IBL -- full split-sum (diffuse + specular).
//
// Demonstrates complete image-based lighting via split-sum approximation:
// diffuse irradiance convolution + specular prefilter mip chain + BRDF LUT.
// Same vendor newport_loft.hdr Skylight input + loadByGuid path as
// sibling 2.ibl-irradiance; see that file's header for the rationale.
//
// AC-06 three-section marker convention:
//   // 1. engine usage            -> public engine API consumed.
//   // 2. example-specific glue   -> demo constants and setup.
//   // 3. bootstrap               -> entry point that wires (1)+(2).

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import type { App, AppError } from '@forgeax/engine-app';
import type { InputBackend } from '@forgeax/engine-input';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  Camera,
  createDevImportTransport,
  createSphereGeometry,
  EngineEnvironmentError,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle, MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  addFirstPersonSystem,
  createFirstPersonControls,
} from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue

const GRID_COLS = 3;
const GRID_ROWS = 3;
const SPACING = 2.5;
const SPHERE_SCALE = 0.9;

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const PACK_INDEX_URL = '/pack-index.json';

const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 0;
const CAMERA_POS_Z = 8;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;


async function setupIblSkylight(
  app: App,
  world: World,
): Promise<Handle<'CubeTextureAsset', 'shared'> | null> {
  const assets = app.renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidRes.ok) {
    console.error(
      `[ibl-specular skylight] NEWPORT_LOFT_GUID parse failed: ${guidRes.error.code}`,
    );
    return null;
  }

  const hdrHandleRes = await assets.loadByGuid<TextureAsset>(guidRes.value);
  if (!hdrHandleRes.ok) {
    console.error(
      `[ibl-specular skylight] loadByGuid(newport_loft.hdr) failed: ${hdrHandleRes.error.code} hint=${hdrHandleRes.error.hint}`,
    );
    return null;
  }

  // feat-20260601-gpu-resource-store-extraction M1: equirect-to-cubemap upload
  // lives on renderer.store. loadByGuid returns the TextureAsset PAYLOAD (M8
  // D-17); mint a user-tier source handle and pass world + handle + pod.
  const srcHandle = world.allocSharedRef('TextureAsset', hdrHandleRes.value);
  const cubemapRes = await app.renderer.store.uploadCubemapFromEquirect(
    world,
    srcHandle,
    hdrHandleRes.value,
  );
  if (!cubemapRes.ok) {
    console.error(
      `[ibl-specular skylight] equirect-to-cubemap upload failed: ${cubemapRes.error.code} hint=${cubemapRes.error.hint}`,
    );
    return null;
  }

  return cubemapRes.value;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 6.pbr 3.ibl-specular] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __iblSpecularInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__iblSpecularInputBackend?.();

  const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
  const appRes: { ok: true; value: App } | { ok: false; error: AppError | RhiError | EngineEnvironmentError } =
    overrideBackend === undefined
      ? await createApp(target, {}, bundler)
      : await createFirstPersonControls(target, overrideBackend, bundler);
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 6.pbr 3.ibl-specular] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const cubemapHandle = await setupIblSkylight(app, world);
  if (cubemapHandle !== null) {
    world.spawn({
      component: Skylight,
      data: { cubemap: cubemapHandle, intensity: 1.0 },
    });
    world.spawn({
      component: SkyboxBackground,
      data: { cubemap: cubemapHandle, mode: SKYBOX_MODE_CUBEMAP },
    });
    console.warn('[learn-render 6.pbr 3.ibl-specular] Skylight + SkyboxBackground active: IBL diffuse + specular split-sum with visible cubemap background');
  }

  const sphereRes = createSphereGeometry(1.0, 32, 16);
  if (!sphereRes.ok) {
    console.error('[learn-render 6.pbr 3.ibl-specular] createSphereGeometry failed:', sphereRes.error);
    return;
  }
  const sphereAssetHandle = world.allocSharedRef('MeshAsset', sphereRes.value);

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const roughness = 0.1 + row * 0.4;
      const metallic = col * 0.5;

      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
        'MaterialAsset',
        Materials.standard({
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic,
          roughness,
        }),
      );

      const cx = (col - (GRID_COLS - 1) / 2) * SPACING;
      const cy = ((GRID_ROWS - 1) / 2 - row) * SPACING;

      world
        .spawn(
          {
            component: Transform,
            data: {
              posX: cx, posY: cy, posZ: 0,
              scaleX: SPHERE_SCALE, scaleY: SPHERE_SCALE, scaleZ: SPHERE_SCALE,
            },
          },
          { component: MeshFilter, data: { assetHandle: sphereAssetHandle } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
    }
  }

  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: {
        posX: CAMERA_POS_X, posY: CAMERA_POS_Y, posZ: CAMERA_POS_Z,
      },
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: CAMERA_FOV,
          aspect: cameraAspect,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
      },
    },
  ).unwrap();

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-ibl-specular-first-person',
    overrideBackend,
  });

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 6.pbr 3.ibl-specular] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 6.pbr 3.ibl-specular] backend=${renderer.backend}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureIblSpecular?: CaptureHook };
  const renderer = app.renderer;
  win.__captureIblSpecular = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 6.pbr 3.ibl-specular] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportBootstrapError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 6.pbr 3.ibl-specular] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 6.pbr 3.ibl-specular] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureIblSpecular?: () => Promise<Uint8Array>;
    __iblSpecularInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
