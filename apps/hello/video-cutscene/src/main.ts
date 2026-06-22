// apps/hello/video-cutscene -- worked example of the host-engine contract
// (feat-20260617-host-engine-contract-and-video-cutscene / M4 / w14).
//
// This demo is the canonical "video cutscene" host pattern documented in
// docs/how-to/2026-06-18-host-engine-contract.md section 4.2. It uses ONLY
// existing engine API and adds ZERO engine video code:
//
//   1. createApp(canvas) boots the engine; a rotating cube is the live world.
//   2. Pressing 'C' calls app.pause() -- requestAnimationFrame is cancelled,
//      the world freezes on its last frame.
//   3. A DOM <video> overlay (host DOM/CSS, contact surface 5) is shown and
//      played. The engine knows nothing about it.
//   4. video.onended hides the overlay and calls app.resume() -- the frame
//      loop resets its dt baseline so the first resumed frame's dt is not
//      inflated by the pause duration (research Finding 8).
//   5. app.stop() (press 'S') cleans up the overlay itself: the engine has no
//      knowledge of the DOM overlay, so overlay teardown is the host's job
//      (contract contact surface 5 + section 4.2 last bullet).
//
// The cutscene <video> carries its own audio track (OOS-7); no audio-bus
// routing and no third-party video/player library is used.

import type { App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!canvas) throw new Error('hello-video-cutscene: missing <canvas id="canvas">');

const videoEl = document.querySelector<HTMLVideoElement>('#video-overlay');
if (!videoEl) throw new Error('hello-video-cutscene: missing <video id="video-overlay">');
const video: HTMLVideoElement = videoEl;

const appRes = await createApp(canvas, { input: false }, forgeaxBundlerAdapter());
if (!appRes.ok) {
  if (appRes.error instanceof EngineEnvironmentError) {
    console.error('[hello-video-cutscene] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[hello-video-cutscene] ${appRes.error.code}: ${appRes.error.hint}`);
  }
  throw new Error('hello-video-cutscene: createApp failed');
}
const app: App = appRes.value;
console.warn(`[hello-video-cutscene] backend=${app.renderer.backend}`);

const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error('[hello-video-cutscene] renderer.ready failed:', ready.error.code);
  throw new Error('hello-video-cutscene: renderer.ready failed');
}

const world = app.world;

// A red cube + light + perspective camera. autoAspect defaults to true, so the
// aspect-sync sidecar on the createApp(canvas) path keeps Camera.aspect in step
// with canvas size (contract contact surface 3).
const cubeMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
  'MaterialAsset',
  Materials.unlit([0.9, 0.3, 0.25, 1]),
);

const cube = world
  .spawn(
    { component: Transform, data: { posY: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

world
  .spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.4,
      directionY: -0.6,
      directionZ: -0.7,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.2,
    },
  })
  .unwrap();

world
  .spawn(
    { component: Transform, data: { posY: 1, posZ: 4, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
    { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: canvas.width / canvas.height }) },
  )
  .unwrap();

// Rotate the cube every frame so a paused world is visibly frozen and a
// resumed world is visibly moving (the cutscene visual contract).
// dt is in seconds (frame-loop clamps to <= 1/30s); ~1 rad/s is a clearly
// visible spin and makes the pause/resume freeze observable.
let angle = 0;
const spin = quat.create();
app.registerUpdate((dt: number) => {
  angle += dt;
  quat.fromAxisAngle(spin, [0, 1, 0], angle);
  // spin is a length-4 Float32Array; noUncheckedIndexedAccess widens the reads
  // to number | undefined, so coalesce to keep the Transform set value typed.
  world.set(cube, Transform, {
    quatX: spin[0] ?? 0,
    quatY: spin[1] ?? 0,
    quatZ: spin[2] ?? 0,
    quatW: spin[3] ?? 1,
  });
});

// --- Cutscene: pause -> overlay -> resume (contract section 4.2) ---

function playCutscene(): void {
  // pause() is idempotent: a no-op (Result.err 'app-not-started') when already
  // paused -- safe to ignore (contract section 4.2).
  const pauseResult = app.pause();
  if (!pauseResult.ok) return;

  video.style.display = 'block';
  video.currentTime = 0;
  void video.play();

  video.onended = () => {
    video.style.display = 'none';
    video.onended = null;
    const resumeResult = app.resume();
    if (!resumeResult.ok) {
      console.error('[hello-video-cutscene] resume failed:', resumeResult.error.code);
    }
  };
}

// stop() ends the frame loop. The engine has no knowledge of the DOM overlay,
// so the host tears it down itself (contract contact surface 5).
function stopApp(): void {
  video.style.display = 'none';
  video.onended = null;
  video.pause();
  const stopResult = app.stop();
  if (!stopResult.ok) {
    console.error('[hello-video-cutscene] stop failed:', stopResult.error.code);
  }
}

// Browser smoke + human both drive the cutscene via the keyboard. The smoke
// reads these globals to trigger the lifecycle deterministically.
Object.assign(globalThis as Record<string, unknown>, {
  __forgeax_video_cutscene__: { playCutscene, stopApp },
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') playCutscene();
  else if (e.key === 's' || e.key === 'S') stopApp();
});

const startResult = app.start();
if (!startResult.ok) {
  console.error('[hello-video-cutscene] app.start failed:', startResult.error.code);
}
