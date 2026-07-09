// apps/learn-render/5.advanced-lighting/3.3.csm/src/main.ts
// LearnOpenGL section 5.3 -- cascaded shadow maps (CSM / PSSM).
// Large wood floor (scale ~50) + 10 cubes spanning 0-40m depth + directional
// light with a 4-cascade castShadow. Walk forward (first-person)
// to see near cubes lit by tight near-cascade shadows and far cubes by the
// coarse far cascade. Keys 1-4 highlight a single cascade band, key 0 turns
// the cascade-overlay debug-viz off, Space toggles the shadow on/off.
//
// The cascade overlay is a demo-local debug-viz post-process (the only
// demo-local GPU code; the shadows themselves ride the engine URP default
// pipeline). It is layered ON TOP of URP via the engine post-URP hook:
// ./cascade-overlay.ts registers the tint shader id and re-installs URP with
// `config.postEffects: [id]` (AUGMENT, not REPLACE -- URP keeps its shadow
// cascades). That wiring lives in ./cascade-overlay.ts so this entry file
// stays scene-spawn + key handlers.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D5 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  AssetRegistry,
  Camera,
  createDevImportTransport,
  DirectionalLight,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import {
  computeCsmSplits,
  csmOverlayModeForKey,
  installCsmOverlay,
  setCsmOverlayMode,
} from './cascade-overlay';

// 2. scene constants

const PACK_INDEX_URL = '/pack-index.json';

// Wood texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
// Metal texture GUID -- the second tileable material in the cube rotation
// (the LearnOpenGL marble asset is not in the engine-assets set; metal is the
// closest tileable stand-in already carved into learn-opengl/textures).
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';

// Floor: large plane (~50 units) on XZ at y=-0.5, normal +Y. createPlaneGeometry
// produces an XY plane facing +Z, so rotate -90 deg about X to lay it flat.
const FLOOR_SIZE = 50;
const FLOOR_Y = -0.5;
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Camera: first-person starting at (0, 1.5, 6) looking -Z down the row.
const CAMERA_POS_Z = 6;
const CAMERA_POS_Y = 1.5;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Directional light shadow: 4-cascade CSM. splitLambda=0.75 blends log + uniform
// PSSM splits; cascadeBlend=0.2 softens cascade seams; mapSize=2048 per tile.
const SHADOW_CONFIG = {
  cascadeCount: 4,
  splitLambda: 0.75,
  cascadeBlend: 0.2,
  mapSize: 2048,
  // Coverage: [camera near, shadowDistance]. Cubes span 0-40m depth, so 50m
  // reach covers the scene while keeping cascade-0 resolution tight.
  shadowDistance: 50,
};

// 10 cubes spanning 0-40m depth at varied positions + heights. `tex` selects
// the material: 'wood' / 'metal' load a GUID texture, a color triple is a solid
// Materials.standard. The depth spread exercises all four cascade bands.
const CUBES = [
  { posX: -2, posY: 0.5, posZ: -1, scaleX: 1, scaleY: 1, scaleZ: 1, tex: 'wood' },
  { posX: 2, posY: 1, posZ: -4, scaleX: 1, scaleY: 2, scaleZ: 1, tex: 'metal' },
  { posX: -3, posY: 0.75, posZ: -8, scaleX: 1.5, scaleY: 1.5, scaleZ: 1.5, tex: [1, 0.3, 0.3] },
  { posX: 3, posY: 0.5, posZ: -12, scaleX: 1, scaleY: 1, scaleZ: 1, tex: 'wood' },
  { posX: -1, posY: 1.5, posZ: -16, scaleX: 1, scaleY: 3, scaleZ: 1, tex: [0.3, 1, 0.3] },
  { posX: 4, posY: 1, posZ: -22, scaleX: 2, scaleY: 2, scaleZ: 2, tex: 'metal' },
  { posX: -4, posY: 0.75, posZ: -28, scaleX: 1.5, scaleY: 1.5, scaleZ: 1.5, tex: [0.3, 0.3, 1] },
  { posX: 1, posY: 1, posZ: -33, scaleX: 1, scaleY: 2, scaleZ: 1, tex: 'wood' },
  { posX: -2, posY: 1.5, posZ: -38, scaleX: 2, scaleY: 3, scaleZ: 2, tex: 'metal' },
  { posX: 3, posY: 1, posZ: -40, scaleX: 1.5, scaleY: 2, scaleZ: 1.5, tex: [1, 1, 0.3] },
] as const;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.3 csm] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.3.3 csm] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 5.3.3 csm] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  if (assets === null) {
    console.error('[learn-render 5.3.3 csm] AssetRegistry is null');
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);

  // Load the two tileable textures (wood floor + metal cube accent) by GUID.
  const woodTex = await loadTextureByGuid(assets, WOOD_GUID_STR);
  const metalTex = await loadTextureByGuid(assets, METAL_GUID_STR);
  if (woodTex === null || metalTex === null) return;

  // Wood floor material POJO.
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
  const woodCubeTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodTex));
  const metalCubeTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', metalTex));

  // Large floor plane.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.3.3 csm] createPlaneGeometry failed:', floorRes.error);
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

  // 10 cubes spanning 0-40m. Materials rotate through wood / metal / solid.
  for (const c of CUBES) {
    const matHandle = world.allocSharedRef('MaterialAsset', cubeMaterial(c.tex, woodCubeTexHandle, metalCubeTexHandle));
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

  // Directional light with a 4-cascade CSM shadow.
  const lightEntity = world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: 0.3, directionY: -0.9, directionZ: -0.3,
        colorR: 1, colorG: 1, colorB: 1, intensity: 1,
        castShadow: true,
        ...SHADOW_CONFIG,
      },
    },
  ).unwrap();

  // First-person camera.
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
    name: 'learn-render-5.3.3-csm-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.3.3 csm] app.start failed:', startRes.error);
    return;
  }

  // Install the cascade-overlay debug-viz. The overlay is now a single
  // shader registered once with structured reads + uniform params; mode
  // changes write the PostProcessParams component UBO (D-8). The call passes
  // `world` so cascade-overlay.ts can spawn the params entity.
  const splits = installCsmOverlay(renderer, world);
  if (splits === null) {
    console.error('[learn-render 5.3.3 csm] installCsmOverlay failed');
  } else {
    console.warn(
      `[learn-render 5.3.3 csm] PSSM splits (demo recompute) = ${Array.from(splits).map((s) => s.toFixed(2)).join(', ')}`,
    );
  }

  // Key handlers: 1-4 highlight a single cascade band, 0 turns the overlay
  // off; Space toggles the shadow on/off via ECS structural change (the engine
  // has no runtime setShadowEnabled API).
  let shadowEnabled = true;
  window.addEventListener('keydown', (e) => {
    const overlayMode = csmOverlayModeForKey(e.key);
    if (overlayMode !== null) {
      e.preventDefault();
      setCsmOverlayMode(overlayMode);
      console.warn(`[learn-render 5.3.3 csm] cascade overlay -> ${overlayMode}`);
      return;
    }
    if (e.key === ' ' || e.key === 'Space') {
      e.preventDefault();
      if (shadowEnabled) {
        world.set(lightEntity, DirectionalLight, { castShadow: false });
        shadowEnabled = false;
        console.warn('[learn-render 5.3.3 csm] shadow disabled via Space toggle');
      } else {
        world.set(lightEntity, DirectionalLight, { castShadow: true, ...SHADOW_CONFIG });
        shadowEnabled = true;
        console.warn('[learn-render 5.3.3 csm] shadow enabled via Space toggle');
      }
    }
  });

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  // Sanity: the demo-recomputed splits should match the engine PSSM formula
  // baked into cascade-overlay.wgsl (logged above for AI users to compare).
  void computeCsmSplits;

  console.warn(`[learn-render 5.3.3 csm] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureCsm?: CaptureHook };
  const renderer = app.renderer;
  win.__captureCsm = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.3.3 csm] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

async function loadTextureByGuid(
  assets: AssetRegistry,
  guidStr: string,
): Promise<TextureAsset | null> {
  const guidRes = AssetGuid.parse(guidStr);
  if (!guidRes.ok) {
    console.error('[learn-render 5.3.3 csm] GUID parse failed:', guidStr);
    return null;
  }
  const texRes = await assets.loadByGuid<TextureAsset>(guidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.3.3 csm] loadByGuid failed:', texRes.error.code);
    return null;
  }
  return texRes.value;
}

function cubeMaterial(
  tex: 'wood' | 'metal' | readonly [number, number, number],
  woodHandle: ReturnType<typeof unwrapHandle>,
  metalHandle: ReturnType<typeof unwrapHandle>,
): MaterialAsset {
  if (tex === 'wood' || tex === 'metal') {
    return {
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
        baseColorTexture: tex === 'wood' ? woodHandle : metalHandle,
      },
    };
  }
  const [r, g, b] = tex;
  return Materials.standard({ baseColor: [r, g, b, 1] });
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string | undefined }>;
    __captureCsm?: () => Promise<Uint8Array>;
  }
}
