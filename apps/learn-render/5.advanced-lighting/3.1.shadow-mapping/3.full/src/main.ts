// apps/learn-render/5.advanced-lighting/3.1.shadow-mapping/3.full/src/main.ts
// LearnOpenGL section 5.3.1 — directional production shadow.
// Wood-textured floor + 5+ cubes with directional light shadow (cascadeCount=1).
// Space toggles shadow on/off; P toggles PCF kernel size between 1 (hard) and 3 (soft).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D3 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  createPlaneGeometry,
  DirectionalLight,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../../shared/src/learn-render-first-person';

// 2. scene constants

const PACK_INDEX_URL = '/pack-index.json';

// Wood texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Floor: 20x20 plane on XZ at y=-0.5, normal +Y. createPlaneGeometry produces XY plane
// facing +Z, so rotate -90 deg about X to lay it flat.
const FLOOR_SIZE = 20;
const FLOOR_Y = -0.5;
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Camera: first-person starting at (0, 1.5, 8) looking -Z.
const CAMERA_POS_Z = 8;
const CAMERA_POS_Y = 1.5;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Directional light shadow: single cascade (degenerate CSM), 2048 atlas, PCF soft.
const SHADOW_CONFIG = {
  cascadeCount: 1,
  mapSize: 2048,
  depthBias: 0.005,
  shadowDistance: 50,
  pcfKernelSize: 3,
};

// Cube scene objects: position, scale, color.
const CUBES = [
  { posX: -3, posY: 1.5, posZ: -2, scaleX: 1, scaleY: 2, scaleZ: 1, color: [1, 0.3, 0.3] },
  { posX: 0, posY: 0.5, posZ: -4, scaleX: 1, scaleY: 1, scaleZ: 1, color: [0.3, 1, 0.3] },
  { posX: 3, posY: 0.75, posZ: -1, scaleX: 1.5, scaleY: 0.5, scaleZ: 1.5, color: [0.3, 0.3, 1] },
  { posX: -4, posY: 1, posZ: -5, scaleX: 0.5, scaleY: 1.5, scaleZ: 0.5, color: [1, 1, 0.3] },
  { posX: 2, posY: 0.5, posZ: -6, scaleX: 2, scaleY: 1, scaleZ: 0.5, color: [1, 0.3, 1] },
  { posX: -1, posY: 0.5, posZ: -3, scaleX: 0.8, scaleY: 0.8, scaleZ: 0.8, color: [0.3, 1, 1] },
] as const;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.1 directional shadow] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 5.3.1 directional shadow] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  if (assets === null) {
    console.error('[learn-render 5.3.1 directional shadow] AssetRegistry is null');
    return;
  }

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Load wood texture through GUID pipeline.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] GUID parse failed');
    return;
  }
  const texRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.3.1 directional shadow] loadByGuid failed:', texRes.error.code);
    return;
  }
  const woodTex = texRes.value;

  // Construct wood floor material POJO.
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        fragmentEntry: 'fs_main',
        tags: { LightMode: 'Forward' },
        passKind: 'forward',
      },
      {
        name: 'ShadowCaster',
        shader: 'forgeax::default-shadow-caster',
        tags: { LightMode: 'ShadowCaster' },
        passKind: 'shadow-caster',
      },
    ],
    paramValues: {
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    },
  });

  // Floor plane: 20x20 on XZ plane at y=-0.5, normal +Y.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] createPlaneGeometry failed:', floorRes.error);
    return;
  }
  const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
  world.spawn(
    {
      component: Transform,
      data: { posY: FLOOR_Y, quatX: FLOOR_QUAT_X, quatW: FLOOR_QUAT_W },
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // Spawn cubes with pure-color Materials.standard.
  for (const c of CUBES) {
    const [r, g, b] = c.color;
    const mat = Materials.standard({ baseColor: [r, g, b, 1] });
    const matHandle = world.allocSharedRef('MaterialAsset', mat);
    world.spawn(
      {
        component: Transform,
        data: {
          posX: c.posX, posY: c.posY, posZ: c.posZ,
          quatW: 1,
          scaleX: c.scaleX, scaleY: c.scaleY, scaleZ: c.scaleZ,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
  }

  // Directional light with shadow (cascadeCount=1 degenerate CSM).
  const lightEntity = world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: 0.2, directionY: -0.98, directionZ: 0,
        colorR: 1, colorG: 1, colorB: 1, intensity: 1,
        castShadow: true,
        ...SHADOW_CONFIG,
      },
    },
  ).unwrap();

  // Camera: first-person starting at (0, 1.5, 8).
  const cameraEntity = world.spawn(
    { component: Transform, data: { posY: CAMERA_POS_Y, posZ: CAMERA_POS_Z } },
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
    name: 'learn-render-5.3.1-first-person',
    overrideBackend: undefined,
  });

  // Shadow / PCF toggles.
  let shadowEnabled = true;
  let currentPcfSize = 3;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Space') {
      e.preventDefault();
      if (shadowEnabled) {
        world.set(lightEntity, DirectionalLight, { castShadow: false });
        shadowEnabled = false;
        console.warn('[learn-render 5.3.1 directional shadow] shadow disabled via Space toggle');
      } else {
        world.set(lightEntity, DirectionalLight, {
          castShadow: true,
          cascadeCount: 1,
          mapSize: 2048,
          depthBias: 0.005,
          shadowDistance: 50,
          pcfKernelSize: currentPcfSize,
        });
        shadowEnabled = true;
        console.warn('[learn-render 5.3.1 directional shadow] shadow enabled via Space toggle');
      }
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      currentPcfSize = currentPcfSize === 1 ? 3 : 1;
      world.set(lightEntity, DirectionalLight, { pcfKernelSize: currentPcfSize });
      console.warn(
        `[learn-render 5.3.1 directional shadow] pcfKernelSize toggled to ${currentPcfSize} via P toggle`,
      );
    }
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.3.1 directional shadow] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.3.1 directional shadow] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureShadowFull?: CaptureHook };
  const renderer = app.renderer;
  win.__captureShadowFull = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.3.1 directional shadow] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureShadowFull?: () => Promise<Uint8Array>;
  }
}