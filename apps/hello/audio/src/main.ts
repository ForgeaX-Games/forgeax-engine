// apps/hello/audio -- spacebar one-shot SFX + movable 3D listener demo
// (feat-20260529-hello-audio-demo-with-spacebar-one-shot-sfx-playba / M3 / w15,
//  updated feat-20260619 M3 w15: audioTickSystem is now auto-registered).
//
// What this demo exercises end-to-end:
//   - createApp({ audio:true, input:true }) auto-registers audioTickSystem
//     (M3 w15 — previously this was a wiring gap: tick was never registered
//     and the declarative path did not actually fire).
//   - Declarative ECS audio path: AudioSource.playing edge is now genuinely
//     consumed by the auto-registered audioTickSystem (not imperative
//     backend.play() bypass).
//   - Spacebar re-arm one-shot state machine (D-3 / D-4):
//     consumer-side edge write — cross-frame false->true edge per keypress
//     via write-true-then-write-false. Not replaced by tick system (D-4).
//   - Listener sync via createAppFromCanvas auto-registered ECS addSystem
//     (M7 w25 — after propagateTransforms, reads current-frame Transform.world).
//     Independent of tick system; no manual registration needed (D-7/D-8).
//   - Overlay text readout (distance + L/R pan) as spatial audio
//     verification anchor (charter F2 -- AC-11)
//   - Pack-index asset resolution: sfx GUID -> relativeUrl -> decode ->
//     registerWithGuid -> AudioSource.clip (AC-06 round-trip)
//
// D-3 one-shot edge mapping (unchanged from original):
//   audioTickSystem reads AudioSource.playing once per frame. A one-shot
//   trigger needs a real false->true transition across TWO frames. The
//   re-arm pattern: on spacebar up-edge, write playing=true; next frame
//   unconditionally write playing=false. This produces:
//     frame N:   false->true (tick sees edge N+1 -> backend.play)
//     frame N+1: true->false (tick sees edge N+2 -> backend.stop)
//     frame N+2+: false (ready for next keypress)
//   README records this ergonomics honestly (AC-08).
//
// SFX GUID SSOT:
//   forgeax-engine-assets/sfx/dragon-studio-correct-472358.mp3.audio.meta.json
//   subAssets[0].guid = 019e7535-5e5e-75fe-a328-0b08e3a72744
const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';

import type { App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import { AudioListener, AudioSource } from '@forgeax/engine-audio';
import { loadAudioClipByGuid } from '@forgeax/engine-audio-webaudio';
import {
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-audio: missing <canvas id="app"> in index.html');

const appRes = await createApp(canvas, {
    audio: true,
  input: true,
}, forgeaxBundlerAdapter());
if (!appRes.ok) {
  if (appRes.error instanceof EngineEnvironmentError) {
    console.error('[hello-audio] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[hello-audio] ${appRes.error.code}: ${appRes.error.hint}`);
  }
  throw new Error('hello-audio: createApp failed');
}
const app: App = appRes.value;
console.warn(`[hello-audio] backend=${app.renderer.backend}`);

const ready = await app.renderer.ready;
if (!ready.ok) {
  console.error('[hello-audio] renderer.ready failed:', ready.error.code, ready.error.hint);
  throw new Error('hello-audio: renderer.ready failed');
}

// Step 2: load the SFX asset through the pack-index pipeline.
// D-7: Dev path resolves via vite-plugin-pack /__pack/lookup/:guid;
// build path resolves via pack-index.json emitted at build time.

// Resolve GUID -> relativeUrl via the pack-index.
let sfxRelativeUrl: string | undefined;
const packIndexRes = await fetch('/pack-index.json');
if (packIndexRes.ok) {
  // pack-index.json (and the dev `/__pack/index` route) serve a flat array
  // of PackIndexEntry rows -- not a `{ entries: [...] }` envelope. GUID
  // comparison is case-insensitive to mirror the dev `/__pack/lookup/:guid`
  // route (vite-plugin-pack index.ts).
  const indexData = (await packIndexRes.json()) as Array<{ guid: string; relativeUrl: string }>;
  const target = SFX_GUID.toLowerCase();
  const entry = Array.isArray(indexData)
    ? indexData.find((e) => e.guid.toLowerCase() === target)
    : undefined;
  sfxRelativeUrl = entry?.relativeUrl;
}
if (!sfxRelativeUrl) {
  // Dev-server fallback: vite-plugin-pack serves /__pack/lookup/:guid
  const devLookupRes = await fetch(`/__pack/lookup/${SFX_GUID}`);
  if (devLookupRes.ok) {
    const lookupData = (await devLookupRes.json()) as { relativeUrl: string };
    sfxRelativeUrl = lookupData.relativeUrl;
  }
}
if (!sfxRelativeUrl) {
  console.warn(
    '[hello-audio] SFX GUID not found in pack-index; demo will be silent (missing --recurse-submodules or pack assets).',
  );
}

const world = app.world;

// Step 3: spawn the 3D scene.
//   - Emitter: a marker cube at origin with AudioSource.
//   - Listener: Camera entity with AudioListener marker.
//   - DirectionalLight for visibility.

// Camera as listener (movable via WASD).
const cameraEntity = world
  .spawn(
    { component: Transform, data: { posX: 0, posY: 1, posZ: 5 } },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 },
    },
    { component: AudioListener, data: {} },
  )
  .unwrap();

// DirectionalLight.
world
  .spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.5,
      directionY: -1,
      directionZ: -0.3,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
    },
  })
  .unwrap();

// Sentry value: a Handle strong enough to compile when AudioSource.clip
// is `handle<AudioClipAsset>` (branded number), yet semantically "none".
const HANDLE_NONE = 0 as unknown as Handle<'AudioClipAsset', 'shared'>;

// Emitter: marker cube at origin.
const emitterEntity = world
  .spawn(
    { component: Transform, data: { posX: 0, posY: 0, posZ: 0 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
    {
      component: AudioSource,
      data: { clip: HANDLE_NONE, playing: false, spatialBlend: 1.0, bus: 'sfx' },
    },
  )
  .unwrap();

// Step 2b: load the audio clip and register with the emitter.
let sfxClipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
if (sfxRelativeUrl) {
  const loadRes = await loadAudioClipByGuid(SFX_GUID, sfxRelativeUrl);
  if (loadRes.ok) {
    const clip = loadRes.value;
    // Mint a user-tier shared ref for the loaded clip payload.
    sfxClipHandle = world.allocSharedRef('AudioClipAsset', clip);
    // Install the clip handle on the emitter's AudioSource.
    world.set(emitterEntity, AudioSource, {
      clip: sfxClipHandle,
      playing: false,
      spatialBlend: 1.0,
      bus: 'sfx',
    });
    console.warn('[hello-audio] SFX loaded and registered');
  } else {
    console.error(
      '[hello-audio] loadAudioClipByGuid failed:',
      loadRes.error.code,
      loadRes.error.hint,
    );
  }
} else {
  console.warn(
    '[hello-audio] skipping audio load (no pack-index entry for SFX GUID; --recurse-submodules clone required)',
  );
}

// Step 4: spacebar re-arm one-shot state machine (D-3).
// Per-frame update callback registered via app.registerUpdate.
// The re-arm produces:
//   - On spacebar up-edge: write AudioSource.playing=true
//   - Next frame: write AudioSource.playing=false (re-arm for next press)
let spacebarReArm = false;
const sfxClipHandleLoaded = sfxClipHandle;

// Step 5-6: listener sync loop + overlay readout.
// Runs inside the same registerUpdate callback.
const overlayEl = document.querySelector<HTMLDivElement>('#overlay');
const listenerEntity = cameraEntity;
const emitterEntityId = emitterEntity;

// Camera movement speed (units/second).
const MOVE_SPEED = 5;

app.registerUpdate((_dt: number) => {
  // Re-read clip handle in case asset loaded after boot.
  const currentClip = sfxClipHandleLoaded;

  // --- Input ---
  const snap = app.renderer.input.snapshot(world);

  // Camera movement (WASD).
  if (snap) {
    const transformRes = world.get(listenerEntity, Transform);
    if (transformRes.ok) {
      const tg = transformRes.value;
      let dx = 0;
      let dz = 0;
      if (snap.keyboard.down('w') || snap.keyboard.down('W')) dz -= MOVE_SPEED * _dt;
      if (snap.keyboard.down('s') || snap.keyboard.down('S')) dz += MOVE_SPEED * _dt;
      if (snap.keyboard.down('a') || snap.keyboard.down('A')) dx -= MOVE_SPEED * _dt;
      if (snap.keyboard.down('d') || snap.keyboard.down('D')) dx += MOVE_SPEED * _dt;
      if (dx !== 0 || dz !== 0) {
        world.set(listenerEntity, Transform, {
          posX: tg.posX + dx,
          posY: tg.posY,
          posZ: tg.posZ + dz,
        });
      }
    }
  }

  // --- Spacebar re-arm state machine (D-3) ---
  if (snap && currentClip !== HANDLE_NONE) {
    const spaceUp = snap.keyboard.up(' ');

    if (spacebarReArm) {
      // Frame after keypress: write false to re-arm.
      world.set(emitterEntityId, AudioSource, {
        clip: currentClip,
        playing: false,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
      spacebarReArm = false;
    } else if (spaceUp) {
      // Spacebar up-edge: write true (produces false->true edge
      // seen by audioTickSystem next frame).
      world.set(emitterEntityId, AudioSource, {
        clip: currentClip,
        playing: true,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
      spacebarReArm = true;
    }
  }

  const listenerTf = world.get(listenerEntity, Transform);
  const listenerWorld = listenerTf.ok ? listenerTf.value.world : undefined;

  // --- Overlay readout (AC-11) ---
  if (overlayEl) {
    const emitterTf = world.get(emitterEntityId, Transform);
    const emitterWorld = emitterTf.ok ? emitterTf.value.world : undefined;
    if (listenerWorld !== undefined && emitterWorld !== undefined) {
      // World-space position = translation column (m[12], m[14] for x, z).
      const lx = listenerWorld[12] ?? 0;
      const lz = listenerWorld[14] ?? 0;
      const ex = emitterWorld[12] ?? 0;
      const ez = emitterWorld[14] ?? 0;
      const dx = ex - lx;
      const dz = ez - lz;
      const distance = Math.hypot(dx, 0, dz).toFixed(1);
      const pan = ex < lx ? 'L' : ex > lx ? 'R' : 'C';
      overlayEl.innerHTML = [
        '<b>spacebar</b> = one-shot SFX &amp; resume AudioContext<br />',
        '<b>WASD</b> = move listener<br />',
        `distance = ${distance} | pan = ${pan}`,
      ].join('');
    }
  }
});

const startRes = app.start();
if (!startRes.ok) {
  console.error(`[hello-audio] app.start failed: ${startRes.error.code}`);
  throw new Error('hello-audio: app.start failed');
}
console.warn('[hello-audio] running. Press spacebar for SFX, WASD to move listener.');
