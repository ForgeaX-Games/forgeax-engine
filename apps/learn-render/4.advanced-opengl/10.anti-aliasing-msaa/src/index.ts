// apps/learn-render/4.advanced-opengl/10.anti-aliasing-msaa -- MSAA hardware
// multisample anti-aliasing OFF/ON comparison demo with Space toggle.
// (feat-20260604-learn-render-4-10-anti-aliasing-msaa-engine-wiring / M3).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource.
//   - ANTIALIAS_MSAA -- the third member of the Camera.antialias enum
//     (hardware multisample geometric anti-aliasing, per-camera toggle).
//   - Space toggle runtime: reads InputSnapshot.keyboard.down(' '),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.antialias between ANTIALIAS_NONE and ANTIALIAS_MSAA via
//     world.set(camEntity, Camera, { antialias }).
//   - DOM HUD overlay (charter F2 text over image): #msaa-hud span
//     updates textContent to "MSAA: ON" / "MSAA: OFF" on every toggle.
//
// Proposition: MSAA = hardware multisample geometric anti-aliasing;
// Space toggles ON/OFF. Compare aliasing on static geometry edges
// (triangle / cube / quad / sphere) -- MSAA ON smooths geometric
// jaggies at edge boundaries (4x sample-count per pixel), while OFF
// reveals raw pixel-stepping.
//
// Scene: 4 static geometries (triangle + cube + quad + sphere) under
// a single slant-directional light. All geometries are stationary so
// the dual-pass smoke can diff cleanly.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) world.allocSharedRef<'MaterialAsset', MaterialAsset>(standard PBR) -> materialHandle
//   (3) world.spawn 4 geometries, DirectionalLight, Camera (save entity)
//   (4) world.addSystem press-edge toggle + HUD sync
//   (5) app.start()

import { createApp } from '@forgeax/engine-app';
import type { App, CanvasAppError } from '@forgeax/engine-app';

import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';

import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[msaa] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[msaa] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[msaa] bootstrap error:', err);
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
  app.onError((error) => {
    console.error('[msaa] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  console.warn(`[msaa] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[msaa] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const world = app.world;

  // Step 2: register the standard PBR material shared across all 4 geometries.
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
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

  // Step 3: spawn 4 static geometries (triangle + cube + quad + sphere).
  // Layout: 4 bodies spread horizontally so edges stay visible and
  // aliasing is obvious in the ANTIALIAS_NONE state. The triangle and
  // cube have the sharpest diagonal edges.
  const LAYOUT: readonly {
    readonly handle: Handle<'MeshAsset', 'shared'>;
    readonly posX: number;
  }[] = [
    { handle: HANDLE_TRIANGLE, posX: -1.05 },
    { handle: HANDLE_CUBE, posX: -0.35 },
    { handle: HANDLE_QUAD, posX: 0.35 },
    { handle: HANDLE_SPHERE, posX: 1.05 },
  ];
  for (const slot of LAYOUT) {
    world.spawn(
      {
        component: Transform,
        data: {
          posX: slot.posX,
          posY: 0,
          posZ: 0,
          quatW: 1,
          scaleX: 0.5,
          scaleY: 0.5,
          scaleZ: 0.5,
        },
      },
      { component: MeshFilter, data: { assetHandle: slot.handle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
  }

  // Step 4: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.4,
      directionY: -0.6,
      directionZ: -0.7,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.5,
    },
  }).unwrap();

  // Step 5: spawn camera starting at ANTIALIAS_NONE (OFF by default).
  // Save the entity handle so the toggle system can call world.set.
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { posZ: 6 },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        antialias: ANTIALIAS_NONE,
      },
    },
  ).unwrap();

  // Step 6: Space-key press-edge toggle system.
  // InputSnapshot has only down (held-level) / up (release-edge), no
  // justPressed, so the demo tracks prev-frame level to derive a
  // false->true press edge. The closure keeps prevSpace and
  // currentAntialias as local state.
  let prevSpace = false;
  let currentAntialias: number = ANTIALIAS_NONE;

  // HUD element (charter F2 text over image): #msaa-hud span mirrors
  // the Camera.antialias value so AI users can read state from DOM.
  const hudEl = document.getElementById('msaa-hud');

  world.addSystem({
    name: 'msaa-space-toggle',
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
          currentAntialias === ANTIALIAS_MSAA ? ANTIALIAS_NONE : ANTIALIAS_MSAA;
        const setRes = world.set(camEntity, Camera, { antialias: target });
        if (setRes.ok) {
          currentAntialias = target;
          if (hudEl) {
            hudEl.textContent =
              target === ANTIALIAS_MSAA ? 'MSAA: ON' : 'MSAA: OFF';
          }
        } else {
          console.error('[msaa] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  // Step 7: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[msaa] running. Press Space to toggle MSAA.');

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureAntiAliasingMsaa?: CaptureHook };
  const renderer = app.renderer;
  win.__captureAntiAliasingMsaa = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.10 anti-aliasing-msaa] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[msaa] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[msaa] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureAntiAliasingMsaa?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
