// apps/hello/video-texture — world-space video texture demo
// (feat-20260623-world-space-video-asset M5 / w20).
//
// Host side: implements a VideoElementProvider that owns <video> DOM
// lifecycle (create / set src / autoplay / mute / dispose), registers it
// as a World Resource so the engine's per-frame record stage can sample
// frames each draw (plan-strategy D-1).
//
// AI-user side: declares a VideoAsset { url } -> loadByGuid -> spawn a
// quad entity with MeshFilter + MeshRenderer + MaterialAsset.paramValues
// referencing the video GUID + VideoPlayer { clip, playing:true, loop:true }.
// The material reuses the same texture2d slot a static texture would (D-5),
// so the AI-user code is line-by-line isomorphic to a static-textured quad
// (charter P4 consistent abstraction).
//
// Test clip: apps/hello/video-cutscene/dist/cutscene.webm (already in repo,
// plan-strategy D-8). Referenced as a relative URL from this app's dev server
// (vite serves the monorepo root). The video-cutscene app is NOT modified
// (AC-11).
//
// Decision anchors:
//   - requirements AC-07 (browser end-to-end visible)
//   - plan-strategy D-1 (host VideoElementProvider), D-8 (test clip reuse)
//   - charter P4 (AI-user code isomorphic to static textures)

import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { VideoAsset } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  HANDLE_QUAD,
  perspective,
  Transform,
  VideoPlayer,
  VIDEO_ELEMENT_PROVIDER_KEY,
} from '@forgeax/engine-runtime';
import type { VideoElementProvider } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// GUIDs: stable per-run (not persisted across builds).
const VIDEO_GUID_STRING = 'f1b3d000-1111-4aaa-9eee-aa1111112222';
const MATERIAL_GUID_STRING = 'b2b3d000-2222-4bbb-9eee-bb2222223333';

// --- host: VideoElementProvider implementation ------------------------------

/**
 * Simple host-side VideoElementProvider: creates one <video> element per
 * entity, caches it, and returns the element on each tick.
 *
 * The engine calls getElement every frame for each VideoPlayer entity; the
 * host owns the <video> DOM lifecycle (creating, setting src, autoplay,
 * mute, dispose) single-sidedly. The engine NEVER constructs a video
 * element or sets `.src` (requirements constraint).
 */
function createDemoVideoProvider(): VideoElementProvider {
  const cache = new Map<number, HTMLVideoElement>();

  function ensureElement(entity: EntityHandle, url: string): HTMLVideoElement {
    const key = entity as unknown as number;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;

    const videoEl = document.createElement('video');
    videoEl.src = url;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.loop = true;
    videoEl.crossOrigin = 'anonymous';
    // Start loading; autoplay may be blocked until user gesture, but the
    // engine's copyExternalImageToTexture only needs a decoded frame.
    videoEl.load();
    videoEl.play().catch(() => {
      // Autoplay blocked: the element will play once a frame is decoded.
      // The engine tolerates videoWidth===0 (returns default view).
    });
    cache.set(key, videoEl);
    return videoEl;
  }

  return {
    getElement(entity, _clipHandle): HTMLVideoElement | undefined {
      return ensureElement(entity, '/cutscene.webm');
    },
  };
}

// --- AI-user: scene recipe --------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('video-texture: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
    renderer.onError((e) => {
      console.error('[video-texture] renderer.onError:', e.code, e.hint);
    });
    console.warn(`[video-texture] backend=${renderer.backend}`);

    const ready = await renderer.ready;
    if (!ready.ok) {
      console.error('[video-texture] renderer.ready failed:', ready.error);
      return;
    }

    const assets = renderer.assets;
    if (assets === null) {
      console.error('[video-texture] AssetRegistry is null');
      return;
    }

    // Step 1: register VideoAsset { kind: 'video', url }
    const videoGuidResult = AssetGuid.parse(VIDEO_GUID_STRING);
    if (!videoGuidResult.ok) {
      console.error('[video-texture] video GUID parse failed:', videoGuidResult.error);
      return;
    }
    const videoGuid = videoGuidResult.value;
    assets.catalog<VideoAsset>(videoGuid, {
      kind: 'video',
      url: '/cutscene.webm',
    });
    const videoHandleRes = await assets.loadByGuid<VideoAsset>(videoGuid);
    if (!videoHandleRes.ok) {
      console.error('[video-texture] loadByGuid video failed:', videoHandleRes.error);
      return;
    }
    console.log('[video-texture] VideoAsset registered');

    // Step 2: register unlit MaterialAsset with paramValues.baseColorTexture=videoGuid.
    // The video GUID occupies the same texture2d slot a static texture would (D-5).
    const matGuidResult = AssetGuid.parse(MATERIAL_GUID_STRING);
    if (!matGuidResult.ok) {
      console.error('[video-texture] material GUID parse failed:', matGuidResult.error);
      return;
    }
    assets.catalog(matGuidResult.value, {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: {
        baseColor: [0.9, 0.9, 0.9],
        // paramValues texture fields are dash-form GUID strings (D-19): the
        // extract stage resolves the string against the catalogue and routes a
        // video-kind payload to the transient DynamicTextureStore. Passing the
        // raw AssetGuid (Uint8Array) here would match neither the string nor the
        // minted-handle (number) arm, silently dropping the slot to default white.
        baseColorTexture: VIDEO_GUID_STRING,
      },
    });
    const matHandleRes = await assets.loadByGuid(matGuidResult.value);
    if (!matHandleRes.ok) {
      console.error('[video-texture] loadByGuid material failed:', matHandleRes.error);
      return;
    }
    console.log('[video-texture] video-textured material registered');

    // Step 3: build world
    const world = new World();

    // Register the host VideoElementProvider as a World Resource. The single
    // per-frame video upload path (the record stage's videoTextureView) reads
    // this resource directly during renderer.draw — there is no separate ECS
    // "video player system" to register (the upload + AC-10 failure signal both
    // live on the real draw path).
    //
    // Falsification hook (`?falsify=1`): SKIP the provider registration. Without
    // a host element the production path hits the AC-10 double-miss, binds the
    // default view, and the quad never shows live video — the smoke's pixel
    // probes MUST then go RED. The browser smoke runs this mode to prove its
    // probes actually detect video content (not e.g. a false-green from the HUD).
    const falsify = new URLSearchParams(globalThis.location?.search ?? '').get('falsify') === '1';
    if (!falsify) {
      const provider = createDemoVideoProvider();
      world.insertResource(VIDEO_ELEMENT_PROVIDER_KEY, provider);
    } else {
      console.warn('[video-texture] FALSIFY mode: VideoElementProvider NOT registered');
    }

    // Spawn camera at (0, 0, 5) looking down -Z. Use the `perspective` factory:
    // it requires fov (RADIANS) + aspect (no schema default for either), so a
    // raw `{ fov: 60, near, far }` would leave aspect=0 (degenerate projection
    // -> nothing on screen) and treat 60 as radians. perspective() fills the
    // 22-column CameraPod correctly.
    world.spawn(
      {
        component: Camera,
        data: perspective({
          fov: Math.PI / 3,
          aspect: target.width / target.height,
          near: 0.1,
          far: 100,
        }),
      },
      { component: Transform, data: { posX: 0, posY: 0, posZ: 5 } },
    );

    // Spawn directional light.
    world.spawn(
      {
        component: DirectionalLight,
        data: {
          directionX: -0.3,
          directionY: -1.0,
          directionZ: -0.5,
          colorR: 1,
          colorG: 1,
          colorB: 1,
          intensity: 1.5,
        },
      },
      { component: Transform, data: { posX: 1, posY: 2, posZ: 1 } },
    );

    // Mint handles from the payloads returned by loadByGuid (D-17:
    // loadByGuid returns the payload — allocSharedRef maps it to a
    // per-world column handle for spawn).
    const videoClipHandle = world.allocSharedRef('VideoAsset', videoHandleRes.value);
    const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

    // Spawn the video-textured quad entity at origin, scaled 2x on X/Y,
    // positioned slightly behind the camera at Z=-1.
    const videoEnt = world.spawn(
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      {
        component: VideoPlayer,
        data: { clip: videoClipHandle, playing: true, loop: true, currentTime: 0 },
      },
      {
        component: Transform,
        data: { posX: 0, posY: 0, posZ: -1, scaleX: 2, scaleY: 2, scaleZ: 1 },
      },
    );
    console.log(`[video-texture] video-textured quad spawned: entity=${String(videoEnt)}`);

    // HUD update.
    const hudEl = document.querySelector<HTMLElement>('#hud');
    if (hudEl) {
      hudEl.textContent = 'World-space video texture demo — quad sampling cutscene.webm';
    }

    // Render loop.
    const frame = (): void => {
      const r = renderer.draw([world], { owner: 0 });
      if (!r.ok) {
        console.error('[video-texture] draw error:', r.error.code, r.error.hint);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err: unknown) {
    console.error('[video-texture] bootstrap error:', err);
  }
}