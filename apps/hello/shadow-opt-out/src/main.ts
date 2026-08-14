// apps/hello/shadow-opt-out - castShadow opt-out + cutout shadow demo
//
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
// AC-17 three-cube castShadow demonstration:
//   A: Materials.standard({baseColor:red}) — casts shadow (default)
//   B: Materials.standard({baseColor:green, castShadow:false}) — no shadow
//   C: custom alpha-test cutout shadow shader — checkerboard-cutout shadow
//
// Visual expectations (requirements §10.5):
//   exp-cube-a-shadow-on-floor: floor region under cube A is darker than floor itself
//   exp-cube-b-no-shadow-on-floor: floor region under cube B is not darkened
//   exp-cube-c-cutout-shadow-pattern: floor region under cube C shows a cutout pattern

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { acquireCanvasContext, createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import '../shaders/cutout-shadow.wgsl';

const CUTOUT_SHADER_PATH = 'shadow_opt_out::cutout_shadow';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-shadow-opt-out: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[shadow-opt-out] no usable backend:', err);
  } else {
    console.error('[shadow-opt-out] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());

  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok) {
      console.error('[shadow-opt-out] canvasContext.configure failed:', cfgResult.error);
    }
  } else {
    console.warn('[shadow-opt-out] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[shadow-opt-out] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[shadow-opt-out] renderer.ready failed:', ready.error);
    return;
  }

  const world = new World();
  const worldAttachment1 = renderer.attachWorld(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;

  // ── Light + shadow ────────────────────────────────────────────────────
  world.spawn(
    {
      component: DirectionalLight,
      data: {
        direction: [-0.3, -1.0, -0.5],
        color: [1, 0.95, 0.9],
        intensity: 1.0,
        mapSize: 1024,
        // feat-20260613-csm M6 / w23: shadow-opt-out runs the single-tile
        // baseline (cascadeCount=1) so AC-10 ("cascadeCount=1 degenerates
        // to single tile via the same WGSL path") is exercised in CI.
        // The same shader code path covers N=1 and N=4; AC-03 forbids any
        // host- or shader-side fallback branch.
        cascadeCount: 1,
        shadowDistance: 60,
      },
    },
  );

  // ── Camera ────────────────────────────────────────────────────────────
  // Camera at (0, 12, 8) looking at origin (the three cubes + floor).
  // quat tilts the default -z forward by ~56.3° around X so the forward
  // vector becomes normalize(target - pos) = (0, -0.832, -0.555).
  // (Identity quat would point straight down -z and miss the entire scene
  // sitting at y≈0..1.25 — manifest of memory
  // [[smoke-camera-pose-untested-misses-cube-with-onerror-zero]]: dawn
  // smoke samples shadow map directly via debugSampleShadowFactor and
  // never reads swap-chain pixels, so a wrong camera pose stays green
  // there but blacks out the browser preview.)
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 12, 8], quat: [-0.4718579255320243, 0, 0, 0.8816745987679437], scale: [1, 1, 1]},
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  // ── Floor (large flat cube) ───────────────────────────────────────────
  // Floor must be a standard (PBR) material — the default-material fallback
  // path (`MeshRenderer { data: {} }`) resolves to an unlit shadingModel that
  // does NOT read the shadow map, so cast shadows from the cubes would
  // never appear on the floor in the browser. dawn smoke missed this
  // because `debugSampleShadowFactor` reads the shadow map directly,
  // bypassing the forward fragment shader entirely
  // ([[m4-structural-smoke-masks-pso-variant-mismatch]]).
  const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.85, 0.85, 0.85, 1] }),
  );
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, -0.01, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  );

  // ── Cube A: red, casts shadow (default) ───────────────────────────────
  const matAHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.1, 0.1, 1] }),
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [-3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matAHandle] } },
  );

  // ── Cube B: green, castShadow: false ──────────────────────────────────
  const matBHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.1, 0.8, 0.1, 1], castShadow: false }),
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matBHandle] } },
  );

  // ── Cube C: custom cutout shadow shader ───────────────────────────────
  const matCHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      { name: 'ShadowCaster', program: { module: CUTOUT_SHADER_PATH }, renderState: { tags: { LightMode: 'ShadowCaster' } } },
    ],
    values: {
      baseColor: [0.1, 0.1, 0.9, 1],
      metallic: 0,
      roughness: 0.5,
    },
  } as MaterialAsset);
  world.spawn(
    {
      component: Transform,
      data: { pos: [3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matCHandle] } },
  );

  const frame = (): void => {
    world.update().unwrap();
    const r = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!r.ok) console.error('[shadow-opt-out] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
