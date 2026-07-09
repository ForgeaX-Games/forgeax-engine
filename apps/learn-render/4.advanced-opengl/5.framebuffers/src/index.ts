// apps/learn-render/4.advanced-opengl/5.framebuffers/src/index.ts
// LearnOpenGL section 4.5 — Framebuffers (offscreen render-to-texture +
// fullscreen post-process effects).
//
// Reproduces the LearnOpenGL "framebuffers" tutorial: render the scene into
// an offscreen color target, then re-sample that target through a fullscreen
// post-process pass into the swap-chain. Six effects are exposed (passthrough
// / inversion / grayscale / sharpen / blur / edge-detection); the user
// switches between them at runtime by pressing keys 1..6 (see T-11).
//
// Pipeline shape (one custom RenderPipeline per effect, hot-swapped via
// `renderer.installPipeline(handle)`):
//
//   addColorTarget('offscreenColor', bgra8unorm, swapchain-size)
//   addColorTarget('offscreenDepth', depth24plus,   swapchain-size)
//   addScenePass('main', { color: 'offscreenColor', depth: 'offscreenDepth' })
//   addFullscreenPass('post', { shader: 'learn-render-5::<effect>',
//                               reads: ['offscreenColor'] })
//
// GREP anchors for AI users:
//   - "// 1. engine usage"   public engine API consumed
//   - "// 2. example glue"   6 RenderPipelineAssets + installPipelineByKey
//   - "// 3. bootstrap"      entry point wiring (1)+(2) + keydown HUD

// 1. engine usage

import { createApp } from '@forgeax/engine-app';
import type { App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { RenderGraph } from '@forgeax/engine-render-graph';
import {
  addFullscreenPass,
  addScenePass,
  Camera,
  createDevImportTransport,
  HANDLE_CUBE,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  type RenderPipeline,
  type RenderPipelineContext,
  type RenderPipelineData,
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

// Six post-process WGSL effects, imported from ./shaders/*.wgsl. The
// vite-plugin-shader transforms each `*.wgsl` module into a `{hash, wgsl}`
// JS module (declared in src/vite-env.d.ts); the `.wgsl` field is the
// post-naga_oil composed source fed to renderer.postProcess.register(...).
import blurShader from './shaders/blur.wgsl';
import edgeShader from './shaders/edge-detection.wgsl';
import grayscaleShader from './shaders/grayscale.wgsl';
import inversionShader from './shaders/inversion.wgsl';
import passthroughShader from './shaders/passthrough.wgsl';
import sharpenShader from './shaders/sharpen.wgsl';

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json.
const CONTAINER_GUID_STR = '019e3969-1d46-773e-988c-a10e305ff2a4';
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';

// Two cubes + one floor quad (the canonical LearnOpenGL 4.5 scene).
const CUBE1_POS: readonly [number, number, number] = [-1, 0, -1];
const CUBE2_POS: readonly [number, number, number] = [2, 0, 0];
const FLOOR_POS: readonly [number, number, number] = [0, -0.5, 0];
const FLOOR_SCALE: readonly [number, number, number] = [5, 5, 1];
// HANDLE_QUAD lies in the XY plane facing +Z; rotate -90deg around X so it
// faces +Y and becomes a horizontal floor (Y=-0.5). Quaternion form: axis=X,
// angle=-pi/2 -> (sin(-pi/4), 0, 0, cos(-pi/4)).
const FLOOR_QUAT_X: number = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W: number = Math.cos(-Math.PI / 4);

// Camera: (0,0,3) looking along -Z, fov 45deg, near 0.1, far 100.
const CAMERA_POS: readonly [number, number, number] = [0, 0, 3];
const CAMERA_FOV: number = Math.PI / 4;
const CAMERA_NEAR: number = 0.1;
const CAMERA_FAR: number = 100.0;

// 2. example glue

// Closed roster of effect keys: '1' .. '6'. The string keys mirror the
// keyboard digits the user presses; the tutorial chapter introduces effects
// in the documented order (passthrough first as the no-op baseline, then
// inversion / grayscale, then 3x3 kernel filters: sharpen / blur / edge).
type EffectKey = '1' | '2' | '3' | '4' | '5' | '6';

interface EffectSpec {
  readonly key: EffectKey;
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
}

const EFFECTS: readonly EffectSpec[] = [
  {
    key: '1',
    id: 'learn-render-5::passthrough',
    displayName: 'passthrough',
    source: passthroughShader.wgsl,
  },
  {
    key: '2',
    id: 'learn-render-5::inversion',
    displayName: 'inversion',
    source: inversionShader.wgsl,
  },
  {
    key: '3',
    id: 'learn-render-5::grayscale',
    displayName: 'grayscale',
    source: grayscaleShader.wgsl,
  },
  {
    key: '4',
    id: 'learn-render-5::sharpen',
    displayName: 'sharpen',
    source: sharpenShader.wgsl,
  },
  { key: '5', id: 'learn-render-5::blur', displayName: 'blur', source: blurShader.wgsl },
  {
    key: '6',
    id: 'learn-render-5::edge-detection',
    displayName: 'edge-detection',
    source: edgeShader.wgsl,
  },
];

// Graph resource keys used by every per-effect pipeline. Centralizing them
// avoids stringly-typed drift between addColorTarget / addScenePass / addFullscreenPass.
const OFFSCREEN_COLOR_KEY = 'offscreenColor';
const OFFSCREEN_DEPTH_KEY = 'offscreenDepth';

/**
 * Build a single per-effect RenderPipeline.buildGraph closure: declare the
 * offscreen color + depth targets, run addScenePass into them, then sample
 * offscreenColor through addFullscreenPass writing to the swap-chain
 * (color: 'swapchain' is unregistered -> resolveCtx returns undefined ->
 * dispatcher falls back to ctx.view, which is the swap-chain view).
 *
 * One closure per effect (not one parameterised closure) so AI users grep
 * `addFullscreenPass` and find the per-effect call site listed by name.
 */
function makeEffectPipeline(shaderId: string): RenderPipeline {
  return {
    buildGraph(
      ctx: RenderPipelineContext,
      _data: RenderPipelineData,
    ): RenderGraph<RenderPipelineContext> | null {
      const graph = new RenderGraph<RenderPipelineContext>();
      // Offscreen color RT format MUST match the geometry pipeline's
      // colorAttachmentFormat — the swap-chain view format chosen by
      // createRenderer (selectSwapChainFormat): 'bgra8unorm-srgb' on
      // macOS/Windows (the UA-preferred canvas format since
      // bug-20260612-webgpu-canvas-format-prefer-bgra), 'rgba8unorm-srgb' on
      // the GLES fallback. Hardcoding 'rgba8unorm-srgb' here mismatched the
      // geometry PSO on BGRA runners (nightly #385/#391). The hardware sRGB
      // encoding on store happens here on the offscreen target, then the
      // fullscreen post sampler reads sRGB-decoded linear values for the effect.
      const swapChainColorFormat =
        ctx.pipelineState?.colorAttachmentFormat ?? 'rgba8unorm-srgb';
      graph.addColorTarget(OFFSCREEN_COLOR_KEY, {
        format: swapChainColorFormat,
        size: 'swapchain',
        sample: 1,
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      // Offscreen depth RT format MUST match the engine's per-frame depth
      // attachment ('depth24plus-stencil8' — the format the geometry pass
      // pipeline cache keys against; using 'depth24plus' alone causes a
      // depth-stencil format mismatch validation error inside the pass).
      graph.addColorTarget(OFFSCREEN_DEPTH_KEY, {
        format: 'depth24plus-stencil8',
        size: 'swapchain',
        sample: 1,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      addScenePass(graph, 'main', {
        color: OFFSCREEN_COLOR_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        // feat-20260609 T-003: required pipeline-specific selector. URP forward
        // pass convention; matches the standard PBR / unlit material's
        // `LightMode: 'Forward'` pass tags so this offscreen render walks the
        // same dispatch as urp-pipeline's main pass.
        selector: { LightMode: ['Forward'] },
        // T-12-a opt-in: route geometry into our offscreen RT, bypassing the
        // urp-pipeline state-machine that picks geometryColorView from the
        // tonemap+MSAA gates in recordFrame.
        _routeFromOpts: true,
      });
      addFullscreenPass(graph, 'post', {
        shader: shaderId,
        // 'swapchain' is the engine-built-in reserved key (T-12-a /
        // graph.ts validateNoUnknownResource): graph.compile accepts it
        // without an addColorTarget declaration; the dispatcher's
        // resolveCtx.resolve('swapchain') returns undefined and the
        // writeView falls through to ctx.view (the current swap-chain view).
        color: 'swapchain',
        reads: [OFFSCREEN_COLOR_KEY],
      });
      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) {
        const e = compileResult.error;
        console.error(
          '[learn-render 4.5 framebuffers] graph.compile failed:',
          e.code,
          'expected:',
          e.expected,
          'hint:',
          e.hint,
          'detail:',
          e.detail,
        );
        return null;
      }
      return graph;
    },
    execute(ctx: RenderPipelineContext): void {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

// Module-level mutable closure so the named installPipelineByKey export
// (called by both M5 dawn smoke and the keydown handler in section 3) can
// install one of the 6 RenderPipelineAsset PODs registered inside
// bootstrap. Populated after bootstrap runs registerPipeline.
let pipelineAssetsByKey: ReadonlyMap<EffectKey, RenderPipelineAsset> | null = null;
let activeRendererForInstall:
  | {
      installPipeline(
        asset: RenderPipelineAsset,
      ): { ok: true } | { ok: false; error: { code: string; hint?: string } };
    }
  | null = null;

/**
 * Install one of the 6 effect pipelines by its keyboard digit ('1' .. '6').
 * Returns a Result-shape (ok / err with a code) so callers (M5 smoke, T-11
 * keydown) check `.ok` per R-9. A call before bootstrap completes returns
 * `'pipelines-not-ready'`; an unknown key returns `'unknown-effect-key'`.
 *
 * Named export (plan-strategy D-5): M5 dawn smoke imports this directly to
 * drive effect switching without simulating keydown.
 */
export function installPipelineByKey(
  key: string,
): { ok: true } | { ok: false; error: { code: string; hint: string } } {
  if (pipelineAssetsByKey === null || activeRendererForInstall === null) {
    return {
      ok: false,
      error: {
        code: 'pipelines-not-ready',
        hint: 'await app.start() resolves before calling installPipelineByKey',
      },
    };
  }
  const asset = pipelineAssetsByKey.get(key as EffectKey);
  if (asset === undefined) {
    return {
      ok: false,
      error: {
        code: 'unknown-effect-key',
        hint: `expected one of '1'..'6'; received ${JSON.stringify(key)}`,
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

/**
 * Public effect-name lookup mirror of installPipelineByKey: returns the
 * display name for HUD updates ('passthrough' / 'inversion' / ...). The HUD
 * keydown handler in section 3 reads this so the DOM text matches whatever
 * pipeline was just installed.
 */
export function effectDisplayNameByKey(key: string): string | null {
  for (const e of EFFECTS) if (e.key === key) return e.displayName;
  return null;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.5 framebuffers] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.5 framebuffers] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.5 framebuffers] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Parse + load the two textures (container.jpg for cubes, metal.png for
  // floor). Both routes return Result<...> -- explicit if (!.ok) checks per
  // R-9 (charter P3 fail-fast: every Result consumer reads .ok before .value).
  const containerGuidRes = AssetGuid.parse(CONTAINER_GUID_STR);
  if (!containerGuidRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] container GUID parse failed:',
      containerGuidRes.error,
    );
    return;
  }
  const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
  if (!metalGuidRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] metal GUID parse failed:',
      metalGuidRes.error,
    );
    return;
  }
  const containerHandleRes = await assets.loadByGuid<TextureAsset>(containerGuidRes.value);
  if (!containerHandleRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] container loadByGuid failed:',
      containerHandleRes.error.code,
    );
    return;
  }
  const metalHandleRes = await assets.loadByGuid<TextureAsset>(metalGuidRes.value);
  if (!metalHandleRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] metal loadByGuid failed:',
      metalHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns texture PAYLOADs (M8 D-17); mint user-tier column
  // handles for the baseColorTexture slots below.
  const containerTex = unwrapHandle(world.allocSharedRef('TextureAsset', containerHandleRes.value));
  const metalTex = unwrapHandle(world.allocSharedRef('TextureAsset', metalHandleRes.value));

  // Cube material: unlit container.jpg. The 4.5 chapter teaches off-screen
  // RT + post-process; the scene shading is intentionally trivial (unlit) so
  // the visual delta between effects is dominated by the post-process pass,
  // not by per-cube lighting.
  const cubeMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: containerTex,
    },
  });

  // Floor material: unlit metal.png. HANDLE_QUAD is a 1x1 quad with a
  // single-tile UV; the 5x5 scale stretches that one tile across the floor
  // (research F-A3 known-difference: unlit has no tiling/offset, so a single
  // wide-tile sample stands in for the LearnOpenGL 25x25 metal-texture floor
  // tiling -- the post-process effect demonstration is unaffected).
  const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: metalTex,
    },
  });

  // Spawn cube #1 at (-1, 0, -1).
  world
    .spawn(
      {
        component: Transform,
        data: { posX: CUBE1_POS[0], posY: CUBE1_POS[1], posZ: CUBE1_POS[2] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    )
    .unwrap();

  // Spawn cube #2 at (2, 0, 0).
  world
    .spawn(
      {
        component: Transform,
        data: { posX: CUBE2_POS[0], posY: CUBE2_POS[1], posZ: CUBE2_POS[2] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    )
    .unwrap();

  // Spawn floor quad at (0, -0.5, 0), 5x5 in XZ (rotate -90deg around X).
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: FLOOR_POS[0],
          posY: FLOOR_POS[1],
          posZ: FLOOR_POS[2],
          quatX: FLOOR_QUAT_X,
          quatW: FLOOR_QUAT_W,
          scaleX: FLOOR_SCALE[0],
          scaleY: FLOOR_SCALE[1],
          scaleZ: FLOOR_SCALE[2],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Camera at (0, 0, 3) looking along -Z (default Transform identity orientation).
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { posX: CAMERA_POS[0], posY: CAMERA_POS[1], posZ: CAMERA_POS[2] },
      },
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
    name: 'learn-render-4.5-first-person',
    overrideBackend: undefined,
  });

  // Register the 6 post-process shader entries + 6 RenderPipeline impls + 6
  // RenderPipelineAsset handles. The 6 calls per channel are inlined (one
  // `renderer.postProcess.register('learn-render-5::<effect>', ...)` and one
  // `renderer.registerPipeline('learn-render-5-pipeline::<effect>', ...)`
  // per effect) so an AI user grepping for either id literal lands on the
  // exact registration line. Each effect uses a distinct pipelineId so
  // installPipeline brand-number compare actually swaps the per-frame graph
  // (a shared id would dedup the brand and the graph would not rebuild).
  try {
    renderer.postProcess.register('learn-render-5::passthrough', {
      source: passthroughShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::passthrough', makeEffectPipeline('learn-render-5::passthrough'));
    renderer.postProcess.register('learn-render-5::inversion', {
      source: inversionShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::inversion', makeEffectPipeline('learn-render-5::inversion'));
    renderer.postProcess.register('learn-render-5::grayscale', {
      source: grayscaleShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::grayscale', makeEffectPipeline('learn-render-5::grayscale'));
    renderer.postProcess.register('learn-render-5::sharpen', {
      source: sharpenShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::sharpen', makeEffectPipeline('learn-render-5::sharpen'));
    renderer.postProcess.register('learn-render-5::blur', {
      source: blurShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::blur', makeEffectPipeline('learn-render-5::blur'));
    renderer.postProcess.register('learn-render-5::edge-detection', {
      source: edgeShader.wgsl,
      reads: [OFFSCREEN_COLOR_KEY],
    });
    // biome-ignore format: keep id literal on the same line for AI-user grep gate
    renderer.registerPipeline('learn-render-5-pipeline::edge-detection', makeEffectPipeline('learn-render-5::edge-detection'));
  } catch (e) {
    console.error('[learn-render 4.5 framebuffers] register threw:', e);
    return;
  }

  // Six RenderPipelineAsset PODs: each `pipelineId` matches the
  // `renderer.registerPipeline(...)` id above. installPipeline takes the POD
  // directly (no shared-ref allocation).
  const passthroughAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::passthrough',
  };
  const inversionAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::inversion',
  };
  const grayscaleAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::grayscale',
  };
  const sharpenAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::sharpen',
  };
  const blurAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::blur',
  };
  const edgeAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'learn-render-5-pipeline::edge-detection',
  };

  pipelineAssetsByKey = new Map<EffectKey, RenderPipelineAsset>([
    ['1', passthroughAsset],
    ['2', inversionAsset],
    ['3', grayscaleAsset],
    ['4', sharpenAsset],
    ['5', blurAsset],
    ['6', edgeAsset],
  ]);
  activeRendererForInstall = renderer;

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.5 framebuffers] app.start failed:', startRes.error);
    return;
  }

  installCaptureHook(app, world);

  // Install effect 1 (passthrough) as the boot default. Subsequent presses of
  // keys 2..6 (handled in the keydown listener below) hot-swap pipelines via
  // installPipelineByKey.
  const initialInstall = installPipelineByKey('1');
  if (!initialInstall.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] initial installPipelineByKey(1) failed:',
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

  // Dev-mode keyboard handler: digits 1..6 hot-swap between the 6 effects.
  // Skipped under dawn-node smoke (no `window`/`document`); the smoke harness
  // calls `installPipelineByKey(...)` directly per plan-strategy D-5.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeEffectKey: EffectKey = '1';
    const hudElement = document.getElementById('hud');
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      // Repeat keys (already-installed effect): no-op idempotent guard.
      if (key === activeEffectKey) return;
      const installResult = installPipelineByKey(key);
      if (!installResult.ok) {
        // Non-1..6 key (or pre-bootstrap) — silently ignore; only the explicit
        // 1..6 codes are part of this demo's surface. Keys outside the closed
        // set are not errors here (avoids spamming console.error on every
        // arrow-key press).
        if (installResult.error.code === 'unknown-effect-key') return;
        console.error(
          '[learn-render 4.5 framebuffers] installPipelineByKey failed:',
          installResult.error,
        );
        return;
      }
      activeEffectKey = key as EffectKey;
      const displayName = effectDisplayNameByKey(key);
      if (hudElement !== null && displayName !== null) {
        hudElement.innerText = displayName;
      }
    });
  }

  console.warn(`[learn-render 4.5 framebuffers] backend=${renderer.backend}`);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureFramebuffers?: CaptureHook };
  const renderer = app.renderer;
  win.__captureFramebuffers = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.5 framebuffers] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureFramebuffers?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
