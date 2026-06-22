// apps/learn-render/5.advanced-lighting/2.gamma-correction/src/index.ts
// LearnOpenGL section 5.2 - Gamma Correction.
//
// Two RenderPipelineAsset handles, hot-swapped via `renderer.installPipeline`:
//   key '1' -> gamma-correct  pipeline (passthrough -> swap-chain sRGB encode = correct)
//   key '2' -> no-gamma       pipeline (pow(col, 2.2) UNDOES sRGB encode = too dark)
//
// The custom RenderPipeline factories live in ./gamma-pipeline.ts; both
// declare an offscreen sRGB color target (rgba8unorm-srgb), and the wrong-
// gamma factory additionally declares a non-sRGB color target (bgra8unorm)
// as the AI-user surface anchor for AC-12. Two inline post-process WGSL
// fragments are registered via `renderer.postProcess.register` (no .wgsl
// files; the demo footprint is intentionally compact).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.2 scene-specific constants + pipelines
//   - "// 3. bootstrap"       entry point wiring (1)+(2) + keydown HUD

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
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
import type {
  MaterialAsset,
  RenderPipelineAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import {
  GAMMA_CORRECT_PIPELINE_ID,
  GAMMA_CORRECT_POSTPROCESS_ID,
  GAMMA_WRONG_PIPELINE_ID,
  GAMMA_WRONG_POSTPROCESS_ID,
  makeGammaPipeline,
} from './gamma-pipeline';

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json
// (chosen over container.jpg for closer fidelity to the LearnOpenGL 5.2
// floor-plane scene; both are sRGB JPEGs and either would exercise the
// gamma path identically).
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Point light at (0, 1.0, 1.0) - LO 5.2 places one positional white light
// above and slightly in front of the floor plane.
const LIGHT_POS_X = 0;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 1.0;

// Camera at (0, 0, 3), 45 deg fov, looking along -Z.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// Inline passthrough fragment shader: samples the offscreen sRGB target
// (HW decodes sRGB -> linear on sample) and returns the value unchanged;
// the swap-chain sRGB view re-encodes on store -> the round-trip is the
// identity transform on the displayed pixel (gamma-correct path).
const PASSTHROUGH_CORRECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  return vec4<f32>(col, 1.0);
}
`;

// Inline wrong-gamma fragment shader: samples the offscreen sRGB target
// (HW decodes sRGB -> linear on sample), then applies pow(col, 2.2) which
// pre-undoes the sRGB encoding the swap-chain will reapply on store. Net
// effect: raw linear values reach the display surface, producing the
// canonical LearnOpenGL 5.2 too-dark "no gamma" image. The wrong path
// stays self-contained inside the fragment shader so the demo's visual
// delta survives the fullscreen-post-process dispatcher's hardcoded
// rgba8unorm-srgb writeView format (see gamma-pipeline.ts comment block).
const WRONG_GAMMA_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  let wrong = pow(col, vec3<f32>(2.2));
  return vec4<f32>(wrong, 1.0);
}
`;

type GammaKey = '1' | '2';

let pipelineAssetsByKey: ReadonlyMap<GammaKey, RenderPipelineAsset> | null = null;
let activeRendererForInstall:
  | {
      installPipeline(
        asset: RenderPipelineAsset,
      ): { ok: true } | { ok: false; error: { code: string; hint?: string } };
    }
  | null = null;

/**
 * Install one of the two gamma pipelines by keyboard digit. '1' -> correct,
 * '2' -> wrong (no-gamma). Returns Result-shape per R-9 (every Result
 * consumer reads .ok before .value). Named export so the dawn smoke can
 * exercise both modes without simulating keydown events.
 */
export function installGammaPipelineByKey(
  key: string,
): { ok: true } | { ok: false; error: { code: string; hint: string } } {
  if (pipelineAssetsByKey === null || activeRendererForInstall === null) {
    return {
      ok: false,
      error: {
        code: 'pipelines-not-ready',
        hint: 'await app.start() resolves before calling installGammaPipelineByKey',
      },
    };
  }
  const asset = pipelineAssetsByKey.get(key as GammaKey);
  if (asset === undefined) {
    return {
      ok: false,
      error: {
        code: 'unknown-gamma-key',
        hint: `expected '1' or '2'; received ${JSON.stringify(key)}`,
      },
    };
  }
  const installRes = activeRendererForInstall.installPipeline(asset);
  if (!installRes.ok) {
    return {
      ok: false,
      error: {
        code: installRes.error.code,
        hint: installRes.error.hint ?? '',
      },
    };
  }
  return { ok: true };
}

/** Public lookup mirror: '1' -> 'correct', '2' -> 'no-gamma'. */
export function gammaDisplayNameByKey(key: string): string | null {
  if (key === '1') return 'correct';
  if (key === '2') return 'no-gamma';
  return null;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.2 gamma-correction] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.2 gamma-correction] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  assets.configurePackIndex(PACK_INDEX_URL);

  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] wood GUID parse failed');
    return;
  }
  const woodHandleRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!woodHandleRes.ok) {
    console.error(
      '[learn-render 5.2 gamma-correction] wood loadByGuid failed:',
      woodHandleRes.error.code,
    );
    return;
  }
  const woodTex = woodHandleRes.value;

  const planeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
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
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    },
  });

  // HANDLE_QUAD lies in XY facing +Z; place at origin so the camera at
  // (0,0,3) looks straight at it. A single textured plane is enough to
  // expose the gamma delta uniformly across the framebuffer.
  world
    .spawn(
      { component: Transform, data: { posZ: 0 } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [planeMat] } },
    )
    .unwrap();

  world.spawn(
    {
      component: Transform,
      data: { posX: LIGHT_POS_X, posY: LIGHT_POS_Y, posZ: LIGHT_POS_Z },
    },
    { component: PointLight, data: {} },
  );

  const cameraEntity = world
    .spawn(
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
    )
    .unwrap();

  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.2-first-person',
    overrideBackend: undefined,
  });

  // Register two inline post-process WGSL fragments + two RenderPipeline
  // impls + two RenderPipelineAsset handles. The two-by-two registration is
  // listed inline (one block per mode) so an AI user grepping for either
  // pipeline id literal lands on the exact registration line.
  try {
    renderer.postProcess.register(GAMMA_CORRECT_POSTPROCESS_ID, {
      source: PASSTHROUGH_CORRECT_WGSL,
      reads: ['offscreenSrgb'],
    });
    renderer.registerPipeline(GAMMA_CORRECT_PIPELINE_ID, makeGammaPipeline('correct'));
    renderer.postProcess.register(GAMMA_WRONG_POSTPROCESS_ID, {
      source: WRONG_GAMMA_WGSL,
      reads: ['offscreenSrgb'],
    });
    renderer.registerPipeline(GAMMA_WRONG_PIPELINE_ID, makeGammaPipeline('wrong'));
  } catch (e) {
    console.error('[learn-render 5.2 gamma-correction] register threw:', e);
    return;
  }

  // D-19: pipeline assets are installed as PODs directly, not user-tier shared
  // refs. Hold the payloads keyed by digit for hot-swap.
  const correctAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: GAMMA_CORRECT_PIPELINE_ID,
  };
  const wrongAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: GAMMA_WRONG_PIPELINE_ID,
  };

  pipelineAssetsByKey = new Map<GammaKey, RenderPipelineAsset>([
    ['1', correctAsset],
    ['2', wrongAsset],
  ]);
  activeRendererForInstall = renderer;

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] app.start failed:', startRes.error);
    return;
  }

  // Install the gamma-correct pipeline as the boot default. Pressing '2'
  // hot-swaps to the no-gamma pipeline; '1' swaps back.
  const initialInstall = installGammaPipelineByKey('1');
  if (!initialInstall.ok) {
    console.error(
      '[learn-render 5.2 gamma-correction] initial installGammaPipelineByKey(1) failed:',
      initialInstall.error,
    );
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  // Dev-mode keyboard handler: '1' / '2' swap between the two pipelines.
  // Skipped under dawn-node smoke (no `window`/`document`); the smoke
  // harness calls `installGammaPipelineByKey(...)` directly.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeKey: GammaKey = '1';
    const hudElement = document.getElementById('hud');
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      if (key === activeKey) return;
      const installResult = installGammaPipelineByKey(key);
      if (!installResult.ok) {
        if (installResult.error.code === 'unknown-gamma-key') return;
        console.error(
          '[learn-render 5.2 gamma-correction] installGammaPipelineByKey failed:',
          installResult.error,
        );
        return;
      }
      activeKey = key as GammaKey;
      const displayName = gammaDisplayNameByKey(key);
      if (hudElement !== null && displayName !== null) {
        hudElement.innerText = `gamma: ${displayName} (press 1 = correct, 2 = no-gamma)`;
      }
    });
  }

  console.warn(`[learn-render 5.2 gamma-correction] backend=${renderer.backend}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
