// 1. engine usage
import { Entity } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import type { App, AppError } from '@forgeax/engine-app';
import type { InputBackend } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  Camera,
  createDevImportTransport,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  PointLight,
  resolveAssetHandle,
  SpotLight,
  Transform,
} from '@forgeax/engine-runtime';
import type {
  MaterialAsset,
  MeshAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-container2.pack.json';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue
const CONTAINER2_TEXTURE_GUID = '019e3969-1d46-7945-a75a-ef97d537531e';
const CONTAINER2_SPECULAR_GUID = '019e3969-1d46-76ca-9a46-2168b746a292';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e3969-2000-7000-8000-000000000003';
const PACK_INDEX_URL = '/pack-index.json';
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_PROJECTION_PERSPECTIVE = 0;
const CUBE_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];

const POINT_LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.7, 0.2, 2.0],
  [2.3, -3.3, -4.0],
  [-4.0, 2.0, -12.0],
  [0.0, 0.0, -3.0],
];

const POINT_LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 1.0, 1.0],
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
];

const LAMP_SCALE = 0.2;

const CUBE_AXIS_RAW = [1.0, 0.3, 0.5] as const;
const CUBE_AXIS_LEN = Math.sqrt(
  CUBE_AXIS_RAW[0] * CUBE_AXIS_RAW[0] +
    CUBE_AXIS_RAW[1] * CUBE_AXIS_RAW[1] +
    CUBE_AXIS_RAW[2] * CUBE_AXIS_RAW[2],
);
const CUBE_AXIS = [
  CUBE_AXIS_RAW[0] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[1] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[2] / CUBE_AXIS_LEN,
] as const;
const CUBE_TILT_RADIANS_PER_INDEX = (20 * Math.PI) / 180;

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: MaterialAsset;
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.6 multiple-lights] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __multipleLightsInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__multipleLightsInputBackend?.();

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
  app.onError((error) => {
    console.error('[learn-render 2.6 multiple-lights] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  const diffuseGuid = parseGuidOrAbort('container2 texture', CONTAINER2_TEXTURE_GUID);
  const specularGuid = parseGuidOrAbort('container2 specular texture', CONTAINER2_SPECULAR_GUID);
  const cubeGuid = parseGuidOrAbort('cube mesh', CUBE_MESH_GUID);
  const materialGuid = parseGuidOrAbort('container2 material', CUBE_MATERIAL_GUID);
  if (diffuseGuid === null || specularGuid === null || cubeGuid === null || materialGuid === null) {
    return;
  }

  const diffuseTextureRes = await assets.loadByGuid<TextureAsset>(diffuseGuid);
  const specularTextureRes = await assets.loadByGuid<TextureAsset>(specularGuid);
  const useTextures = diffuseTextureRes.ok && specularTextureRes.ok;
  if (!diffuseTextureRes.ok) {
    console.warn(
      '[learn-render 2.6 multiple-lights] continuing untextured after diffuse loadByGuid failure:',
      diffuseTextureRes.error.code,
      diffuseTextureRes.error.hint,
    );
  }
  if (!specularTextureRes.ok) {
    console.warn(
      '[learn-render 2.6 multiple-lights] continuing untextured after specular loadByGuid failure:',
      specularTextureRes.error.code,
      specularTextureRes.error.hint,
    );
  }

  const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 2.6 multiple-lights] HANDLE_CUBE asset unavailable');
    return;
  }
  assets.catalog<MeshAsset>(cubeGuid, cubeAssetRes.value);

  const materialEntry = readMaterialPackEntry(materialPackJson);
  if (materialEntry === null) {
    return;
  }
  // feat-20260523 M8-T03: the pack stores texture slots as GUID strings, but
  // the render-system extract stage binds a texture only when the slot is a
  // resolved numeric Handle. loadByGuid returns the texture PAYLOAD (M8 D-17);
  // mint a user-tier column handle via allocSharedRef for the diffuse/specular
  // slots; drop the slot on texture-load failure so the schema-driven path
  // falls back to placeholders.
  const paramValuesIn = materialEntry.payload.paramValues as Readonly<
    Record<string, unknown>
  >;
  const filteredValues: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(paramValuesIn)) {
    if (k === 'baseColorTexture') {
      if (!diffuseTextureRes.ok) continue;
      filteredValues[k] = unwrapHandle(
        world.allocSharedRef('TextureAsset', diffuseTextureRes.value),
      );
      continue;
    }
    if (k === 'metallicRoughnessTexture') {
      if (!specularTextureRes.ok) continue;
      filteredValues[k] = unwrapHandle(
        world.allocSharedRef('TextureAsset', specularTextureRes.value),
      );
      continue;
    }
    filteredValues[k] = v;
  }
  const materialAsset: MaterialAsset = {
    kind: 'material',
    passes: materialEntry.payload.passes ?? [],
    paramValues: filteredValues,
  };
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    materialAsset,
  );
  void materialGuid;
  const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuid);
  if (!cubeHandleRes.ok) {
    console.error(
      '[learn-render 2.6 multiple-lights] loadByGuid mesh failed:',
      cubeHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns the payload (M8 D-17); mint a user-tier column handle.
  const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
  void useTextures;

  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    const pos = CUBE_POSITIONS[i];
    if (pos === undefined) continue;
    const angle = i * CUBE_TILT_RADIANS_PER_INDEX;
    const halfAngle = angle * 0.5;
    const sinH = Math.sin(halfAngle);
    const cosH = Math.cos(halfAngle);
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX: pos[0],
            posY: pos[1],
            posZ: pos[2],
            quatX: CUBE_AXIS[0] * sinH,
            quatY: CUBE_AXIS[1] * sinH,
            quatZ: CUBE_AXIS[2] * sinH,
            quatW: cosH,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
  }

  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: {
        fov: CAMERA_FOV_RADIANS,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        projection: CAMERA_PROJECTION_PERSPECTIVE,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
  );

  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.2,
      directionY: -1,
      directionZ: -0.3,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 0.5,
    },
  });

  for (let i = 0; i < POINT_LIGHT_POSITIONS.length; i++) {
    const plPos = POINT_LIGHT_POSITIONS[i];
    const plColor = POINT_LIGHT_COLORS[i];
    if (plPos === undefined || plColor === undefined) continue;
    const lampMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [{ name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 }],
      paramValues: { baseColor: [plColor[0], plColor[1], plColor[2], 1.0] },
    });
    world.spawn(
      {
        component: Transform,
        data: {
          posX: plPos[0],
          posY: plPos[1],
          posZ: plPos[2],
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: LAMP_SCALE,
          scaleY: LAMP_SCALE,
          scaleZ: LAMP_SCALE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [lampMatHandle] } },
      {
        component: PointLight,
        data: {
          colorR: plColor[0],
          colorG: plColor[1],
          colorB: plColor[2],
          intensity: 100,
          range: 50,
        },
      },
    );
  }

  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    {
      component: SpotLight,
      data: {
        directionX: 0,
        directionY: 0,
        directionZ: -1,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 4,
        range: 50,
        innerConeDeg: 12.5,
        outerConeDeg: 17.5,
      },
    },
  );

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-multiple-lights-first-person',
    overrideBackend,
    flashlight: { spotLightQuery: true },
  });
  addScrollFovSystem(world, renderer);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.6 multiple-lights] app.start failed:', startRes.error.code, startRes.error.hint);
  }
}

function readMaterialPackEntry(rawPack: unknown): MaterialPackEntry | null {
  const materialPack = rawPack as MaterialPackFile;
  const materialEntry = materialPack.assets.find((entry) => entry.kind === 'material');
  if (materialEntry === undefined) {
    console.error('[learn-render 2.6 multiple-lights] material-container2.pack.json missing material entry');
    return null;
  }
  return materialEntry;
}

function addScrollFovSystem(world: App['world'], renderer: App['renderer']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem({
    name: 'learn-render-multiple-lights-scroll-fov',
    after: ['input-frame-start-scan'],
    queries: [{ with: [Camera, Entity] }],
    fn: (world, queryResults) => {
      const snapshot = renderer.input.snapshot(world);
      if (snapshot === undefined) {
        return;
      }
      scrollFov.apply(snapshot.mouse.wheelDelta);
      for (const bundles of queryResults[0]) {
        for (let i = 0; i < bundles.Entity.self.length; i++) {
          bundles.Camera.fov[i] = scrollFov.fovRad;
        }
      }
    },
  });
}

function parseGuidOrAbort(label: string, guidLiteral: string): AssetGuid | null {
  const guidRes = AssetGuid.parse(guidLiteral);
  if (!guidRes.ok) {
    console.error(
      `[learn-render 2.6 multiple-lights] invalid ${label} GUID:`,
      guidLiteral,
      guidRes.error.code,
      guidRes.error.hint,
    );
    return null;
  }
  return guidRes.value;
}

function reportBootstrapError(error: AppError | RhiError | EngineEnvironmentError): void {
  if (error instanceof EngineEnvironmentError) {
    const webgpuError = error.detail.webgpuError;
    const innerCode = webgpuError !== undefined && 'code' in webgpuError ? webgpuError.code : '<none>';
    console.error(`[learn-render 2.6 multiple-lights] EngineEnvironmentError: webgpu inner=${innerCode}`);
    return;
  }
  console.error(`[learn-render 2.6 multiple-lights] ${error.code}: ${error.hint}`);
}

declare global {
  interface Window {
    __multipleLightsInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
