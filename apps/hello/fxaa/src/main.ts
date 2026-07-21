import { Update } from '@forgeax/engine-ecs';
// apps/hello/fxaa -- FXAA real-time comparison demo
// (feat-20260529-fxaa-demo-real-antialiasing-comparison-runtime-tog / M2).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource (feat-20260518-app-shell-game-loop).
//   - HANDLE_SPHERE -- the 4th builtin mesh handle (id=4, radius=1
//     16x12, 12-float interleaved layout, same as HANDLE_CUBE /
//     HANDLE_TRIANGLE / HANDLE_QUAD).
//   - Space toggle runtime: reads InputSnapshot.keyboard.down('Space'),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.antialias between ANTIALIAS_NONE and ANTIALIAS_FXAA via
//     world.set(camEntity, Camera, { antialias }). The engine extract
//     stage re-reads antialias every frame (zero engine-side code change).
//   - DOM HUD overlay (charter F2 text over image): #fxaa-hud span
//     updates textContent to "FXAA: ON" / "FXAA: OFF" on every toggle.
//
// Scene: 4 static geometries (triangle + cube + quad + sphere) under a
// single slant-directional light direction ~(-0.4, -0.6, -0.7). All
// geometries are stationary (D-5) so dual-pass smoke can diff cleanly.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) define the 5 standard components via defineComponent (globally live)
//   (3) assets.register<MaterialAsset>(standard PBR) -> materialHandle
//   (4) world.spawn 4 geometries, DirectionalLight, Camera (save entity)
//   (5) world.addSystem press-edge toggle + HUD sync
//   (6) app.start()

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';

import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { ANTIALIAS_FXAA, ANTIALIAS_NONE, Camera, DirectionalLight, EngineEnvironmentError, MeshFilter, MeshRenderer, perspective, Transform } from '@forgeax/engine-runtime';

import type { Handle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[fxaa] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[fxaa] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[fxaa] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[fxaa] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[fxaa] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const world = app.world;

  // Step 2: alloc the standard PBR material as a user-tier shared ref on the
  // World, shared across all 4 geometries (D-19: engine-built payloads live on
  // world.sharedRefs, not the AssetRegistry).
  const materialHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  });

  // Step 3: register the 5 standard components.

  // Step 4: spawn 4 static geometries (triangle + cube + quad + sphere).
  // Layout: 4 bodies spread horizontally so edges stay visible and
  // aliasing is obvious in the ANTIALIAS_NONE state (PI-3). Each
  // body is scaled to 0.5 to fit all 4 in view without overlap.
  const LAYOUT: readonly {
    readonly handle: Handle<'MeshAsset', 'shared'>;
    readonly pos: readonly [number, number, number];
  }[] = [
    { handle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0]},
    { handle: HANDLE_CUBE, pos: [-0.35, 0, 0]},
    { handle: HANDLE_QUAD, pos: [0.35, 0, 0]},
    { handle: HANDLE_SPHERE, pos: [1.05, 0, 0]},
  ];
  for (const slot of LAYOUT) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: slot.pos,
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: slot.handle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
  }

  // Step 5: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  }).unwrap();

  // Step 6: spawn camera starting at ANTIALIAS_NONE (OFF by default).
  // Save the entity handle so the toggle system (w7) can call world.set.
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 6]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        antialias: ANTIALIAS_NONE,
      },
    },
  ).unwrap();

  // Step 7: Space-key press-edge toggle system.
  // InputSnapshot has only down (held-level) / up (release-edge), no
  // justPressed (D-6 F-1), so the demo tracks prev-frame level to derive
  // a false->true press edge (PD-2 / PI-2). The closure keeps prevSpace
  // and currentAntialias as local state -- no ECS resource needed
  // (charter P1: single-file readability).
  let prevSpace = false;
  let currentAntialias: number = ANTIALIAS_NONE;

  // HUD element (charter F2 text over image): #fxaa-hud span mirrors
  // the Camera.antialias value so AI users can read state from DOM.
  const hudEl = document.getElementById('fxaa-hud');

  world.addSystem(Update, {
    name: 'fxaa-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;

      // InputSnapshot.keyboard matches KeyboardEvent.key (browser backend
      // stores ev.key), so the spacebar is the literal ' ' -- NOT 'Space'
      // (that is ev.code). See packages/input/src/input-snapshot.ts down() doc.
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        // Press edge: toggle antialias.
        const target =
          currentAntialias === ANTIALIAS_FXAA ? ANTIALIAS_NONE : ANTIALIAS_FXAA;
        const setRes = world.set(camEntity, Camera, { antialias: target });
        if (setRes.ok) {
          currentAntialias = target;
          if (hudEl) {
            hudEl.textContent =
              target === ANTIALIAS_FXAA ? 'FXAA: ON' : 'FXAA: OFF';
          }
        } else {
          // Surface the failure rather than silently dropping the toggle
          // (charter P3: an empty signal must not masquerade as success).
          console.error('[fxaa] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  // Step 8: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[fxaa] running. Press Space to toggle FXAA.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[fxaa] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[fxaa] ${err.code}: ${err.hint}`);
}