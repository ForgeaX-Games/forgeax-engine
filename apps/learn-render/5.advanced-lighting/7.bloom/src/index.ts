// apps/learn-render/5.advanced-lighting/7.bloom/src/index.ts
// LearnOpenGL section 5.7 - Bloom.
//
// Bloom via URP default pipeline + Camera bloom fields (BLOOM_ENABLED,
// bloomThreshold, bloomIntensity, bloomBlurRadius). No custom pipeline
// code: the seven-step URP bloom chain (bright-filter -> blur-x -> blur-y
// -> composite) is declared by the engine and opt-in via Camera fields.
//
// Contrast with apps/hello/bloom/ which proves the engine's bloom
// infrastructure; this demo teaches the LO 5.7 lighting scenario
// (emissive light boxes on a wood floor). hello/bloom toggles bloom
// on/off at runtime via Space key — this demo always enables bloom and
// varies emissive intensity across light boxes to teach the threshold
// concept (boxes with intensity > threshold glow; boxes below don't).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example-specific glue"  LO 5.7 scene-specific constants + materials
//   - "// 3. bootstrap"       entry point wiring (1)+(2) + HUD

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  BLOOM_ENABLED,
  Camera,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/
//   wood.png                GUID 019e3969-1d48-7c3b-ac24-6d68f457065f
//   container2.png          GUID 019e3969-1d46-7945-a75a-ef97d537531e
//   container2_specular.png GUID 019e3969-1d46-76ca-9a46-2168b746a292
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';
const CONTAINER2_SPECULAR_GUID_STR = '019e3969-1d46-76ca-9a46-2168b746a292';

// Bloom configuration (aligned with hello/bloom smoke (d) PASS configuration:
// threshold=1.0, intensity=1.0, blurRadius=4.0).
const BLOOM_THRESHOLD = 1.0;
const BLOOM_INTENSITY = 1.0;
const BLOOM_BLUR_RADIUS = 4.0;

// 3 light boxes: emissiveIntensity {2.0, 1.5, 0.4}.
// The first two exceed bloomThreshold=1.0 and trigger bloom; the third
// stays below the threshold for a didactic Bright/Dim contrast.
const BOX_A_INTENSITY = 2.0;
const BOX_B_INTENSITY = 1.5;
const BOX_C_INTENSITY = 0.4;

// Light box emissive color: warm white (slightly orange).
const BOX_EMISSIVE_COLOR: readonly [number, number, number] = [2.0, 1.8, 1.5];

// Box layout: three light boxes sitting on the wood floor, spaced along X.
//   box A (intensity=2.0, blooms): posX = -3.0
//   box B (intensity=1.5, blooms): posX =  0.0
//   box C (intensity=0.4, dim):    posX =  3.0
const BOX_POS_Y = 0.6;
const BOX_POS_Z = 0.0;
const BOX_SCALE = 0.7;
const BOX_A_POS_X = -3.0;
const BOX_B_POS_X = 0.0;
const BOX_C_POS_X = 3.0;

// Wood floor: large flat quad at origin, scaled to cover the light box area.
const FLOOR_SCALE_X = 10.0;
const FLOOR_SCALE_Z = 4.0;
const FLOOR_POS_Y = -0.5;

// Point light above the scene to illuminate the wood floor and boxes.
const LIGHT_POS_X = 0.0;
const LIGHT_POS_Y = 3.0;
const LIGHT_POS_Z = 2.0;

// Camera at (0, 1.5, 8), looking toward the light box row.
const CAMERA_POS_X = 0.0;
const CAMERA_POS_Y = 1.5;
const CAMERA_POS_Z = 8.0;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.7 bloom] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.7 bloom] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.7 bloom] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  // Load textures by GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
  const container2SpecularGuidRes = AssetGuid.parse(CONTAINER2_SPECULAR_GUID_STR);
  if (!woodGuidRes.ok || !container2GuidRes.ok || !container2SpecularGuidRes.ok) {
    console.error('[learn-render 5.7 bloom] GUID parse failed');
    return;
  }

  const [woodTexRes, container2TexRes, container2SpecularTexRes] = await Promise.all([
    assets.loadByGuid<TextureAsset>(woodGuidRes.value),
    assets.loadByGuid<TextureAsset>(container2GuidRes.value),
    assets.loadByGuid<TextureAsset>(container2SpecularGuidRes.value),
  ]);
  if (!woodTexRes.ok || !container2TexRes.ok || !container2SpecularTexRes.ok) {
    console.error('[learn-render 5.7 bloom] loadByGuid failed');
    return;
  }
  const woodTex = woodTexRes.value;
  const container2Tex = container2TexRes.value;
  const container2SpecularTex = container2SpecularTexRes.value;

  // Register materials.
  // Wood floor: standard PBR + wood base color texture.
  const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.9,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    }),
  );

  // Light box helper: standard PBR with emissiveTexture (container2_specular)
  // used as an emissive mask (metal border glows, painted surface doesn't).
  function makeBoxMaterial(intensity: number): MaterialAsset {
    return Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.3,
      metallic: 0.8,
      emissive: BOX_EMISSIVE_COLOR,
      emissiveIntensity: intensity,
      emissiveTexture: unwrapHandle(world.allocSharedRef('TextureAsset', container2SpecularTex)),
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', container2Tex)),
    });
  }

  const boxAMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    makeBoxMaterial(BOX_A_INTENSITY),
  );
  const boxBMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    makeBoxMaterial(BOX_B_INTENSITY),
  );
  const boxCMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    makeBoxMaterial(BOX_C_INTENSITY),
  );

  // Spawn wood floor: HANDLE_CUBE scaled flat and wide.
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: FLOOR_POS_Y,
          posZ: 0,
          scaleX: FLOOR_SCALE_X,
          scaleY: 0.1,
          scaleZ: FLOOR_SCALE_Z,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Spawn 3 emissive light boxes.
  for (const [posX, handle] of [
    [BOX_A_POS_X, boxAMatHandle],
    [BOX_B_POS_X, boxBMatHandle],
    [BOX_C_POS_X, boxCMatHandle],
  ] as const) {
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX,
            posY: BOX_POS_Y,
            posZ: BOX_POS_Z,
            scaleX: BOX_SCALE,
            scaleY: BOX_SCALE,
            scaleZ: BOX_SCALE,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [handle] } },
      )
      .unwrap();
  }

  // Point light to illuminate the scene.
  world.spawn(
    {
      component: Transform,
      data: { posX: LIGHT_POS_X, posY: LIGHT_POS_Y, posZ: LIGHT_POS_Z },
    },
    { component: PointLight, data: {} },
  );

  // Camera with bloom + tonemap enabled.
  // Camera.bloom=BLOOM_ENABLED opt-in drives the URP default bloom chain
  // (bright-filter -> blur-h -> blur-v -> composite). No custom pipeline
  // code needed — this is the "Camera fields as API" paradigm, contrasted
  // with 6.hdr's custom RenderPipeline paradigm.
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { posX: CAMERA_POS_X, posY: CAMERA_POS_Y, posZ: CAMERA_POS_Z },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: CAMERA_FOV,
            aspect: target.width / target.height,
            near: CAMERA_NEAR,
            far: CAMERA_FAR,
          }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          bloom: BLOOM_ENABLED,
          bloomThreshold: BLOOM_THRESHOLD,
          bloomIntensity: BLOOM_INTENSITY,
          bloomBlurRadius: BLOOM_BLUR_RADIUS,
        },
      },
    )
    .unwrap();

  // First-person controls so the AI user can explore the bloom scene.
  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.7-bloom-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.7 bloom] app.start failed:', startRes.error);
    return;
  }

  // HUD: display bloom status and light box intensity reference.
  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  const hudElement = document.getElementById('hud');
  if (hudElement !== null) {
    hudElement.innerText =
      'bloom: ON (threshold=1.0, intensity=1.0) | boxes: emissiveIntensity A=2.0 B=1.5 C=0.4';
  }

  console.warn(`[learn-render 5.7 bloom] backend=${renderer.backend}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}