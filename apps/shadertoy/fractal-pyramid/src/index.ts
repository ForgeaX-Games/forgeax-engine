// apps/shadertoy/fractal-pyramid/src/index.ts
//
// Shadertoy reproduction: "fractal pyramid" (https://www.shadertoy.com/view/tsXBzS).
//
// The effect is a fullscreen raymarcher. We reproduce it as a custom material
// shader (fractal-pyramid.wgsl) bound to a fullscreen quad:
//   - createPlaneGeometry(1, 1) yields a unit plane on XY in [-0.5, 0.5]; the
//     custom vertex shader scales it x2 to fill NDC [-1, 1] and ignores the
//     camera transform, so the quad always covers the whole viewport.
//   - The Shadertoy iResolution / iTime globals ride in the @group(1)@binding(0)
//     material UBO via paramSchema [iResolution: vec2, iTime: f32]. The raf loop
//     mutates paramValues.iTime every frame (same per-frame param mutation path
//     the hello/custom-shader pulse demo uses).
//
// A Camera entity is spawned only so the engine runs the forward pass (with no
// camera the renderer just clears); its pose is irrelevant because the custom
// vertex shader emits clip-space positions directly.

import { World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  Camera,
  createRenderer,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  Name,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import fractalShader from './fractal-pyramid.wgsl';

const FRACTAL_SHADER_PATH = 'shadertoy::fractal-pyramid';

// Render scale relative to CSS pixels. This raymarcher is heavily
// fragment-bound (64 march steps x 8 fractal iterations per pixel), so cost is
// linear in the rendered pixel count. Shadertoy renders ~1:1 with CSS pixels;
// multiplying by devicePixelRatio (2 on Retina) would quadruple the work and
// tank the framerate at large widths. Keep this at 1.0 to match Shadertoy;
// drop below 1.0 (e.g. 0.75) for extra headroom, or read ?scale= from the URL.
//
// Declared BEFORE the bootstrap() invocation below: `const` lives in the
// temporal dead zone until its line executes, and bootstrap()'s first
// (pre-await) statement calls resolveRenderScale(), so an earlier call site
// would throw a ReferenceError and the whole app would fail to start (black).
const DEFAULT_RENDER_SCALE = 1.0;

function resolveRenderScale(): number {
  if (typeof window === 'undefined') return DEFAULT_RENDER_SCALE;
  const fromUrl = new URLSearchParams(window.location.search).get('scale');
  const parsed = fromUrl === null ? Number.NaN : Number.parseFloat(fromUrl);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RENDER_SCALE;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('fractal-pyramid: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[fractal-pyramid] no usable backend:', err);
  } else {
    console.error('[fractal-pyramid] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Size the backing store from CSS pixels * RENDER_SCALE (NOT devicePixelRatio)
  // so iResolution tracks the rendered grid and the raymarch aspect stays
  // correct, while the pixel count stays Shadertoy-comparable.
  const renderScale = resolveRenderScale();
  const cssW = target.clientWidth || 800;
  const cssH = target.clientHeight || 600;
  target.width = Math.max(1, Math.floor(cssW * renderScale));
  target.height = Math.max(1, Math.floor(cssH * renderScale));

  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok) {
      console.error('[fractal-pyramid] canvasContext.configure failed:', cfgResult.error);
    }
  } else {
    console.warn('[fractal-pyramid] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[fractal-pyramid] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[fractal-pyramid] renderer.ready failed:', ready.error);
    return;
  }

  const shader = renderer.shader;
  const assets = renderer.assets;
  if (shader === null || assets === null) {
    console.error('[fractal-pyramid] renderer.shader or renderer.assets is null; the fullscreen-effect demo requires a fully initialized WebGPU backend.');
    return;
  }
  const world = new World();

  // Register the custom material shader under the path identifier declared in
  // the .wgsl `#define_import_path` header. paramSchema is the SSOT for the UBO
  // layout: iResolution (vec2) then iTime (f32) merge into one std140 block.
  shader.registerMaterialShader(FRACTAL_SHADER_PATH, {
    source: fractalShader.wgsl,
    paramSchema: [
      { name: 'iResolution', type: 'vec2' },
      { name: 'iTime', type: 'f32' },
    ],
  });

  const paramValues: Record<string, number | number[]> = {
    iResolution: [target.width, target.height],
    iTime: 0,
  };
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: FRACTAL_SHADER_PATH,
        tags: { LightMode: 'Forward' },
        queue: 2000,
        // The fullscreen quad must never be back-face culled regardless of the
        // plane winding; the raymarch fills every pixel of the viewport.
        renderState: { cullMode: 'none' },
      },
    ],
    paramValues,
  });

  const planeRes = createPlaneGeometry(1, 1);
  if (!planeRes.ok) {
    console.error('[fractal-pyramid] createPlaneGeometry failed:', planeRes.error);
    return;
  }
  const planeMeshHandle = world.allocSharedRef('MeshAsset', planeRes.value);

  world
    .spawn(
      { component: Name, data: { value: 'fullscreen-quad' } as never },
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: planeMeshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  // Camera exists only so the engine runs the forward pass; the custom vertex
  // shader ignores its transform.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3]} },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: cssW / cssH }) },
    )
    .unwrap();

  // Keep iResolution in sync with the canvas on resize.
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      const w = target.clientWidth || cssW;
      const h = target.clientHeight || cssH;
      target.width = Math.max(1, Math.floor(w * renderScale));
      target.height = Math.max(1, Math.floor(h * renderScale));
      paramValues.iResolution = [target.width, target.height];
    });
  }

  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    paramValues.iTime = (now - startTime) / 1000;
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[fractal-pyramid] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
