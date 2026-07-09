// apps/learn-render/4.advanced-opengl/6.cubemaps/src/index.ts
// LearnOpenGL section 4.advanced-opengl 6.cubemaps — equirect HDR skybox +
// reflection contrast (plan D-3: code from ibl-specular, glue from 4.6).
//
// Demonstrates equirect-to-cubemap conversion + Skylight (PBR IBL) +
// SkyboxBackground (visible cubemap background) + reflective vs non-reflective
// cube side-by-side comparison. Mirrors LO 4.6 cubemaps teaching concept
// through forgeax-first equirect HDR routing (no 6-PNG cubemap loader — OOS-3).
//
// GREP anchors for AI users:
//   "// 1. engine usage"    public engine API consumed (copy-paste)
//   "// 2. example glue"    LO 4.6 scene-specific constants + GUIDs (customize)
//   "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import type { App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  DirectionalLight,
  HANDLE_CUBE,
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
import type { EquirectAsset, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 0;
const CAMERA_POS_Z = 6;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.6 cubemaps] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.6 cubemaps] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.6 cubemaps] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  assets.configurePackIndex(PACK_INDEX_URL);

  // Parse newport_loft.hdr GUID (forgeax-engine-assets vendor submodule, CC BY-NC 4.0).
  const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidRes.ok) {
    console.error(`[learn-render 4.6 cubemaps] GUID parse failed: ${guidRes.error.code}`);
    return;
  }

  // Load HDR equirect through the GUID asset pipeline. loadByGuid returns the
  // EquirectAsset PAYLOAD (D-17); mint a user-tier column handle for it. The
  // equirect->cubemap + IBL projection is now INTERNAL to the engine (lazy, in
  // the render record arm) -- no manual cubemap upload call. LO 4.6's 6-PNG
  // cubemap loader is replaced by this single equirect HDR source.
  const hdrHandleRes = await assets.loadByGuid<EquirectAsset>(guidRes.value);
  if (!hdrHandleRes.ok) {
    console.error(
      `[learn-render 4.6 cubemaps] loadByGuid(newport_loft.hdr) failed: ${hdrHandleRes.error.code}`,
    );
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: hdrHandleRes.error.code, hint: hdrHandleRes.error.hint });
    return;
  }
  const equirect = world.allocSharedRef('EquirectAsset', hdrHandleRes.value);

  // Skylight provides PBR IBL diffuse+specular illumination for the whole scene.
  // It holds the equirect handle directly; the engine projects the cubemap lazily.
  world.spawn({
    component: Skylight,
    data: { equirect, intensity: 1.0 },
  });

  // SkyboxBackground renders the same equirect (as the internally-projected
  // cubemap) as the visible background (AC-01).
  world.spawn({
    component: SkyboxBackground,
    data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
  });
  console.warn('[learn-render 4.6 cubemaps] Skylight + SkyboxBackground active: equirect HDR skybox visible, PBR IBL reflections active');

  // Reflective cube (metallic=1, roughness=0) at left — mirrors IBL environment.
  const reflectiveMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.8, 0.8, 0.8, 1],
      metallic: 1,
      roughness: 0,
    }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { posX: -1.5, posY: 0, posZ: 0 },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [reflectiveMatHandle] } },
    )
    .unwrap();

  // Non-reflective cube (metallic=0) at right — matte surface, no IBL mirror.
  const nonReflectiveMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.8, 0.8, 0.8, 1],
      metallic: 0,
      roughness: 0.5,
    }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { posX: 1.5, posY: 0, posZ: 0 },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [nonReflectiveMatHandle] } },
    )
    .unwrap();

  // DirectionalLight for PBR shading on cubes.
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.4,
      directionY: -0.6,
      directionZ: -0.7,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.5,
    },
  });

  const cameraAspect = target.width / target.height;
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: CAMERA_POS_X,
          posY: CAMERA_POS_Y,
          posZ: CAMERA_POS_Z,
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
          // LO 4.6 dark slate clear (was the retired RendererOptions.clearColor;
          // sinks here per feat-20260608 D-1).
          clearR: 0.1,
          clearG: 0.1,
          clearB: 0.1,
          clearA: 1.0,
        },
      },
    )
    .unwrap();

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-4.6-cubemaps-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.6 cubemaps] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 4.6 cubemaps] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureCubemaps?: CaptureHook };
  const renderer = app.renderer;
  win.__captureCubemaps = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.6 cubemaps] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureCubemaps?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}