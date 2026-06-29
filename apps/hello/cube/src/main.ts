// apps/hello/cube - ECS-driven binding exemplar (M4 RHI canvas-context migration).
//
// shadingModel routing (feat-20260518-pbr-direct-lighting-mvp / w24 / AC-13;
// feat-20260523 M8-T03 doc refresh: StandardMaterialAsset retired in favour
// of the schema-driven register API):
//   `populateDemoWorld` spawns the cube with `MeshRenderer { data: {} }` — the
//   empty material handle drops through render-system-extract.ts case B fallback
//   to `defaultMaterialSnapshot()` (mid-grey, `shadingModel: 'unlit'`). The
//   demo intentionally does NOT register a PBR material; basic-primitive demos
//   like hello-cube belong on the unlit pipeline (no DirectionalLight coupling
//   required). For an explicit `MaterialAsset { shadingModel: 'unlit' }`
//   register-and-bind exemplar see `apps/learn-render/1.getting-started/4.textures/src/index.ts`;
//   for the flagship schema-driven GGX-PBR + DirectionalLight pairing (built
//   via `assetRegistry.registerMaterialAsset({ materialShader:
//   'forgeax::default-standard-pbr', ... })`) see `apps/hello/room/src/main.ts`.
//
// Four-step recipe AI users discover via @forgeax/engine-runtime
// (charter proposition 1 progressive disclosure):
//   (1) import 5-component schemas + HANDLE_CUBE.
//   (2) world.spawn(...) cube + Camera + DirectionalLight.
//   (3) await renderer.ready (D-S3 manifest -> pipeline -> assets serial).
//   (4) raf -> renderer.draw(world) (D-S2 RenderSystem internal phase).
//
// M4 RHI canvas-context migration (feat-20260510-rhi-resource-creation /
// w28): the previous D-S1 single-point escape hatch
// (`_internal_getRawDevice`) is replaced with the M3-shipped RHI
// canvas-context abstraction. The shim translates the forgeax RhiDevice
// brand passed to `canvasContext.configure({ device, ... })` into the
// underlying raw GPUDevice via RAW_DEVICE_MAP so the spec
// `GPUCanvasContext.configure({ device })` slot still receives a valid
// raw device handle while AI-user-facing code only sees the forgeax
// abstraction (charter proposition 5 consistent abstraction red line).
//
// The canonical 3-entity demo World (cube + camera + directional light)
// is shared with apps/inspector-demo via apps/shared/src/populate-demo-world.ts
// (feat-20260514-ci-jscpd-duplication-gate M3 T-014 / clone #2 path-A cash-out).

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError, Name } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { populateDemoWorld } from '../../../shared/src/populate-demo-world';

// feat-20260617-rhi-debug-layered-browser-capture M4 / w22 + w25: hello-cube
// bootstraps via createApp(canvas, {}, bundler) -- the canvas form owns the
// renderer + World + rAF driver + canvasContext.configure internally, and is
// the form that mounts globalThis.__forgeax.captureFrame(n) under
// FORGEAX_ENGINE_RHI_DEBUG=1 (create-app.ts guard, M3). The dev RHI-debug
// browser e2e (scripts/smoke-browser.mjs) drives that affordance. The prior
// createRenderer + acquireCanvasContext escape-hatch exemplar now lives in
// apps/hello/triangle; hello-cube keeps its role as the ECS binding +
// Name-component exemplar through populateDemoWorld + the Name round-trip below.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-cube: missing <canvas id="app"> in index.html');

const app = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!app.ok) {
  reportError(app.error);
} else {
  const world = app.value.world;
  populateDemoWorld(world);

  // feat-20260515-ecs-name-component-and-string-schema M3 / w3-hello-cube-app
  // (AC-14): canonical Name + 'string' schema vocab end-to-end exemplar. AI
  // users discover the round-trip via `rg "Name { value:" apps/hello/cube` --
  // spawn + read + mutate + despawn, driven before app.start() so the
  // BufferPool 3-path release is observable independent of the frame loop.
  const player = world.spawn({ component: Name, data: { value: 'Player' } as never }).unwrap();
  const initialName = world.get(player, Name).unwrap().value;
  void initialName;
  world.set(player, Name, { value: 'Boss' } as never).unwrap();
  const mutatedName = world.get(player, Name).unwrap().value;
  void mutatedName;
  world.despawn(player).unwrap();

  app.value.start();
}

function reportError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error('[cube] no usable backend:', err);
    return;
  }
  console.error(`[cube] ${err.code}: ${err.hint}`);
}
