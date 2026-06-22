// apps/learn-render/6.pbr/2.ibl-irradiance/src/index.ts
// LearnOpenGL section 6.2 IBL -- diffuse irradiance sphere matrix.
//
// Demonstrates image-based lighting with diffuse irradiance only (no
// prefilter / BRDF LUT). A Skylight component sources its equirect HDR
// from the vendor LearnOpenGL newport_loft.hdr (CC-BY-NC carve-out in the
// forgeax-engine-assets submodule, GUID 019e4a26-3c29-7420-af5d-20f2724a16b0),
// loaded through the production loadByGuid -> decodeHdr ->
// uploadCubemapFromEquirect path. A 3x3 sphere matrix varies roughness +
// metallic across x / y axes to show how diffuse IBL interacts with the
// PBR pipeline.
//
// AGENTS.md "Demo failures route to engine fixes, not workarounds": the
// demo never synthesises a placeholder HDR; if loadByGuid fails or the
// vendor submodule is uninitialised the error surfaces via console.error
// rather than silently swapping in a procedural gradient.
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
  Skylight,
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
      `[ibl-irradiance skylight] NEWPORT_LOFT_GUID parse failed: ${guidRes.error.code}`,
    );
    return null;
  }

  const hdrHandleRes = await assets.loadByGuid<TextureAsset>(guidRes.value);
  if (!hdrHandleRes.ok) {
    console.error(
      `[ibl-irradiance skylight] loadByGuid(newport_loft.hdr) failed: ${hdrHandleRes.error.code} hint=${hdrHandleRes.error.hint}`,
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
      `[ibl-irradiance skylight] equirect-to-cubemap upload failed: ${cubemapRes.error.code} hint=${cubemapRes.error.hint}`,
    );
    return null;
  }

  return cubemapRes.value;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 6.pbr 2.ibl-irradiance] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __iblIrradianceInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__iblIrradianceInputBackend?.();

  // Host-explicit dev transport (OOS-1): the HDR equirect source is lazily
  // imported via POST /__import on a DDC miss. Hoisted to a single bundler
  // const so AC-11 "exactly 1 adapter call per demo file" holds across the
  // ternary (feat-20260608 / M3).
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
    console.error('[learn-render 6.pbr 2.ibl-irradiance] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const cubemapHandle = await setupIblSkylight(app, world);
  if (cubemapHandle !== null) {
    world.spawn({
      component: Skylight,
      data: { cubemap: cubemapHandle, intensity: 1.0 },
    });
    console.warn('[learn-render 6.pbr 2.ibl-irradiance] Skylight active: IBL diffuse irradiance');
  }

  const sphereRes = createSphereGeometry(1.0, 32, 16);
  if (!sphereRes.ok) {
    console.error('[learn-render 6.pbr 2.ibl-irradiance] createSphereGeometry failed:', sphereRes.error);
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
          baseColor: [0.8, 0.8, 0.8, 1],
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
      data: perspective({
        fov: CAMERA_FOV,
        aspect: cameraAspect,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-ibl-irradiance-first-person',
    overrideBackend,
  });

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 6.pbr 2.ibl-irradiance] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 6.pbr 2.ibl-irradiance] backend=${renderer.backend}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureIblIrradiance?: CaptureHook };
  const renderer = app.renderer;
  win.__captureIblIrradiance = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 6.pbr 2.ibl-irradiance] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportBootstrapError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 6.pbr 2.ibl-irradiance] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 6.pbr 2.ibl-irradiance] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureIblIrradiance?: () => Promise<Uint8Array>;
    __iblIrradianceInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
