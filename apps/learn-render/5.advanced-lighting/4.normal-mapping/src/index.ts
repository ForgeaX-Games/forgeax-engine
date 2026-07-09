// apps/learn-render/5.advanced-lighting/4.normal-mapping/src/index.ts
// LearnOpenGL section 5.4 - Normal Mapping.
// Tangent-space normal-mapped brick wall with point-light PBR shading.
//
// Textures loaded through GUID asset pipeline:
//   configurePackIndex('/pack-index.json') + loadByGuid<TextureAsset>.
//
// MaterialAsset is constructed as a POJO directly (no Materials.standard()
// factory call) to demonstrate the raw asset shape for AI users.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.4 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json
const BRICKWALL_GUID_STR = '019e3969-1d45-78a4-9f59-a41c910656f4';
const BRICKWALL_NORMAL_GUID_STR = '019e3969-1d46-78ef-b4d9-0163f7f93193';

// Point light position (LO 5.4: (0.5, 1.0, 0.3)).
const LIGHT_POS_X = 0.5;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 0.3;

// Camera: (0, 0, 3), Zoom=45 deg.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.4 normal-mapping] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.4 normal-mapping] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Parse texture GUIDs.
  const brickwallGuidRes = AssetGuid.parse(BRICKWALL_GUID_STR);
  const brickwallNormalGuidRes = AssetGuid.parse(BRICKWALL_NORMAL_GUID_STR);
  if (!brickwallGuidRes.ok || !brickwallNormalGuidRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] GUID parse failed');
    return;
  }

  // Load textures through the GUID asset pipeline.
  const baseColorRes = await assets.loadByGuid<TextureAsset>(brickwallGuidRes.value);
  const normalRes = await assets.loadByGuid<TextureAsset>(brickwallNormalGuidRes.value);
  if (!baseColorRes.ok || !normalRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) {
      if (!baseColorRes.ok) bus.push({ code: baseColorRes.error.code, hint: baseColorRes.error.hint });
      if (!normalRes.ok) bus.push({ code: normalRes.error.code, hint: normalRes.error.hint });
    }
    console.error(
      '[learn-render 5.4 normal-mapping] loadByGuid failed:',
      baseColorRes.ok ? null : baseColorRes.error.code,
      normalRes.ok ? null : normalRes.error.code,
    );
    return;
  }
  const baseColorTex = baseColorRes.value;
  const normalTex = normalRes.value;

  // Construct MaterialAsset POJO directly (no Materials.standard()).
  // baseColorTexture and normalTexture are Handles resolved from GUIDs.
  const wallMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.8,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', baseColorTex)),
      normalTexture: unwrapHandle(world.allocSharedRef('TextureAsset', normalTex)),
    },
  });

  // Spawn quad: HANDLE_QUAD is 1x1 in XY plane, faces +Z (toward camera at (0,0,3)).
  world.spawn(
    { component: Transform, data: { posZ: 0 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [wallMat] } },
  ).unwrap();

  // Point light at (0.5, 1, 0.3) — LO 5.4 verbatim.
  world.spawn(
    {
      component: Transform,
      data: { posX: LIGHT_POS_X, posY: LIGHT_POS_Y, posZ: LIGHT_POS_Z },
    },
    { component: PointLight, data: {} },
  );

  // Camera at (0, 0, 3), Zoom=45 deg. First-person system drives
  // WASD/mouse/scroll on top of this spawn.
  const cameraEntity = world.spawn(
    { component: Transform, data: { posZ: CAMERA_POS_Z } },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.4-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.4 normal-mapping] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureNormalMapping?: CaptureHook };
  const renderer = app.renderer;
  win.__captureNormalMapping = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.4 normal-mapping] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureNormalMapping?: () => Promise<Uint8Array>;
  }
}