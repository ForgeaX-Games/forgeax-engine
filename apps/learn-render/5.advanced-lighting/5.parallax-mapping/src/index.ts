// apps/learn-render/5.advanced-lighting/5.parallax-mapping/src/index.ts
// LearnOpenGL section 5.5 - Parallax Mapping (basic / steep / POM).
//
// One custom material shader (parallax.wgsl) carries all three LO 5.5
// algorithms; the active path + height scale + texture set are switched at
// runtime by mutating the MaterialAsset.paramValues object BY REFERENCE in a
// keydown handler (D-7) — extract/record pick up the change next frame, no
// recompile.
//
// Per-shader-derived BGL (feat-20260621): the parallax shader's paramSchema
// declares THREE texture fields (baseColor / normal / HEIGHT). The engine
// derives the @group(1) material BGL from that schema, so the height-map slot
// exists end-to-end without any engine edit — that is the structural win this
// demo dogfoods.
//
// Custom shader path (charter F1 grep gate):
//   grep `registerMaterialShader` -> finds this file
//   grep `learn-render::5-5-parallax` -> finds WGSL + index.ts + meta.json
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.5 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Camera, createDevImportTransport, MeshFilter, MeshRenderer, perspective, Transform } from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

import parallaxShader from './parallax.wgsl';

const PARALLAX_SHADER_ID = 'learn-render::5-5-parallax' as const;

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs (forgeax-engine-assets/learn-opengl/textures/*.meta.json).
// Each set is diffuse + normal + displacement(height). depth/disp maps are
// linear-colorspace data textures.
const TEXTURE_SETS = {
  bricks2: {
    label: 'bricks2',
    diffuse: '019e3969-1d45-744f-8269-e1b1c6e6a8cf',
    normal: '019e3969-1d45-7020-8756-675a0f885532',
    height: '019e3969-1d45-7d3e-9bc8-55fcdc87beab',
  },
  toyBox: {
    label: 'toy_box',
    diffuse: '019e3969-1d47-7920-8f00-3d458255d479',
    normal: '019e3969-1d48-77f0-9acb-b5fecfc42a7a',
    height: '019e3969-1d48-7458-aa6b-0e2f42cc46aa',
  },
} as const;

const ALGO_LABELS = ['basic', 'steep', 'parallax-occlusion'] as const;

// Camera: (0, 0, 3), FOV=45 deg (LO 5.5). The quad faces +Z toward the camera;
// WASD/mouse (first-person system) lets the user reach grazing angles where
// the parallax depth cue is strongest.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// heightScale tuning bounds (LO 5.5 default 0.1).
const HEIGHT_SCALE_DEFAULT = 0.1;
const HEIGHT_SCALE_STEP = 0.02;
const HEIGHT_SCALE_MIN = 0.0;
const HEIGHT_SCALE_MAX = 0.5;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.5 parallax-mapping] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.5 parallax-mapping] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.5 parallax-mapping] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  assets.configurePackIndex(PACK_INDEX_URL);

  // Register the parallax custom material shader. The paramSchema mirrors the
  // .meta.json sidecar (the build path's SSOT); this runtime registration is
  // the dawn-node / non-Vite fallback.
  const shader = renderer.shader;
  if (shader === null) {
    console.error('[learn-render 5.5 parallax-mapping] renderer.shader is null');
    return;
  }
  shader.registerMaterialShader(PARALLAX_SHADER_ID, {
    source: parallaxShader.wgsl,
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'heightScale', type: 'f32', default: HEIGHT_SCALE_DEFAULT },
      { name: 'algoMode', type: 'f32', default: 0.0 },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'normalTexture', type: 'texture2d' },
      { name: 'heightTexture', type: 'texture2d' },
    ],
  });

  // Load both texture sets up front so set-switching is a paramValues swap
  // (no async on keypress). Each loaded TextureAsset is wrapped into a column
  // handle once; the handle ints are what paramValues carries.
  const loadSet = async (
    set: (typeof TEXTURE_SETS)[keyof typeof TEXTURE_SETS],
  ): Promise<{ diffuse: number; normal: number; height: number } | null> => {
    const guids = [set.diffuse, set.normal, set.height].map((g) => AssetGuid.parse(g));
    if (!guids.every((r) => r.ok)) {
      console.error(`[learn-render 5.5 parallax-mapping] GUID parse failed for ${set.label}`);
      return null;
    }
    const loaded = await Promise.all(
      guids.map((r) => assets.loadByGuid<TextureAsset>((r as { value: AssetGuid }).value)),
    );
    if (!loaded.every((r) => r.ok)) {
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      for (const r of loaded) {
        if (!r.ok && bus !== undefined) bus.push({ code: r.error.code, hint: r.error.hint });
      }
      console.error(`[learn-render 5.5 parallax-mapping] loadByGuid failed for ${set.label}`);
      return null;
    }
    const [diffuse, normal, height] = loaded.map((r) =>
      unwrapHandle(world.allocSharedRef('TextureAsset', (r as { value: TextureAsset }).value)),
    );
    return { diffuse: diffuse ?? 0, normal: normal ?? 0, height: height ?? 0 };
  };

  const bricksHandles = await loadSet(TEXTURE_SETS.bricks2);
  const toyBoxHandles = await loadSet(TEXTURE_SETS.toyBox);
  if (bricksHandles === null || toyBoxHandles === null) return;

  // Construct the MaterialAsset POJO. We keep a live reference to paramValues
  // so the keydown handler can mutate algoMode / heightScale / texture handles
  // in place — extract reads the same object next frame (D-7).
  const paramValues: Record<string, number | number[]> = {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    heightScale: HEIGHT_SCALE_DEFAULT,
    algoMode: 0.0,
    baseColorTexture: bricksHandles.diffuse,
    normalTexture: bricksHandles.normal,
    heightTexture: bricksHandles.height,
  };
  const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', shader: PARALLAX_SHADER_ID, tags: { LightMode: 'Forward' } }],
    paramValues: paramValues as Readonly<Record<string, unknown>>,
  });

  // Wall quad facing +Z (HANDLE_QUAD = createPlaneGeometry(1,1) with tangents
  // at @location(3); the shader builds its TBN from them).
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0]} },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [mat] } },
  ).unwrap();

  const cameraEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, CAMERA_POS_Z]} },
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
    name: 'learn-render-5.5-first-person',
    overrideBackend: undefined,
  });

  // HUD + keyboard switching. algoMode/heightScale/texture-set are discrete
  // events: mutate paramValues by reference; the next extract picks it up.
  const hud = document.querySelector<HTMLPreElement>('#hud');
  let activeSet: 'bricks2' | 'toyBox' = 'bricks2';
  const renderHud = (): void => {
    if (hud === null) return;
    const algo = ALGO_LABELS[Math.round(paramValues.algoMode as number)] ?? '?';
    const setLabel = activeSet === 'bricks2' ? 'bricks2' : 'toy_box';
    hud.textContent = [
      'LearnOpenGL 5.5 — Parallax Mapping',
      `algorithm : ${algo}   [1 basic] [2 steep] [3 POM]`,
      `heightScale: ${(paramValues.heightScale as number).toFixed(2)}   [-]/[=] adjust`,
      `texture   : ${setLabel}   [T] toggle`,
      'camera    : WASD + mouse drag, scroll = zoom',
    ].join('\n');
  };
  renderHud();

  window.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case '1':
        paramValues.algoMode = 0.0;
        break;
      case '2':
        paramValues.algoMode = 1.0;
        break;
      case '3':
        paramValues.algoMode = 2.0;
        break;
      case '-':
      case '_':
        paramValues.heightScale = Math.max(
          HEIGHT_SCALE_MIN,
          (paramValues.heightScale as number) - HEIGHT_SCALE_STEP,
        );
        break;
      case '=':
      case '+':
        paramValues.heightScale = Math.min(
          HEIGHT_SCALE_MAX,
          (paramValues.heightScale as number) + HEIGHT_SCALE_STEP,
        );
        break;
      case 't':
      case 'T': {
        activeSet = activeSet === 'bricks2' ? 'toyBox' : 'bricks2';
        const h = activeSet === 'bricks2' ? bricksHandles : toyBoxHandles;
        paramValues.baseColorTexture = h.diffuse;
        paramValues.normalTexture = h.normal;
        paramValues.heightTexture = h.height;
        break;
      }
      default:
        return;
    }
    renderHud();
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.5 parallax-mapping] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.5 parallax-mapping] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureParallaxMapping?: CaptureHook };
  const renderer = app.renderer;
  win.__captureParallaxMapping = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.5 parallax-mapping] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureParallaxMapping?: () => Promise<Uint8Array>;
  }
}
