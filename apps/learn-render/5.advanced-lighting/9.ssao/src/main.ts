// apps/learn-render/5.advanced-lighting/9.ssao/src/main.ts
// LearnOpenGL section 5.9 — Screen-Space Ambient Occlusion.
//
// Faithful to the LearnOpenGL 5.9 scene:
//   - an enclosing room the camera sits inside (LO scales one cube to 7.5 with
//     inverted normals; the engine's deferred g-buffer pass uses default
//     back-face culling, so SSAO would not see an inverted cube's inner walls —
//     we build the same box from inward-facing slabs instead, which the
//     g-buffer renders correctly);
//   - ONE detailed model resting on the floor: the SAME backpack LO 5.9 uses
//     (`forgeax-engine-assets/learn-opengl/objects/backpack/backpack.gltf`,
//     converted from the upstream LearnOpenGL `backpack.obj`). Loaded as a
//     SceneAsset by GUID + instantiated — the gltfImporter already wired its
//     diffuse / specular / normal textures, so SSAO reads its many straps,
//     buckles and pockets as crease AO;
//   - ONE dim light-blue point light (LO `lightColor=(0.2,0.2,0.7)`);
//   - a dominant ambient term that SSAO modulates. LO computes
//     `ambient = vec3(0.3) * AO`; the engine's ambient comes from Skylight/IBL,
//     so a solid-color Skylight at low intensity reproduces the 0.3 constant
//     ambient that SSAO darkens.
//
// SSAO darkens the ambient term in creases / concave corners / contact seams.
// SSAO reads the deferred g-buffer (normal + depth), so EVERY surface that
// should receive AO is drawn with `Materials.standard` (deferred + forward).
//
// SSAO is selected by one literal field on the Standard profile
// (`standardProfile.ssao = true`). `FALSIFY=ssao-off` disables it for A/B.
//
// Charter mapping:
//   - F1 single-entry indexability: SSAO turn-on is one literal field.
//   - P3 explicit failure: invalid feature plans return structured Render errors.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" room + model + light + SSAO config
//   - "// 3. bootstrap"       entry point wiring

// 1. engine usage

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App, createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { DEFAULT_STANDARD_PROFILE, Materials, Skylight } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import { type MaterialAsset, type SceneAsset } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';

// 2. scene constants — faithful LO 5.9 SSAO scene (room + model)


// Enclosing room: floor + ceiling + back/left/right walls, each a thin slab
// with inward-facing surfaces (default culling, all in the g-buffer). The box
// spans [-ROOM, ROOM] horizontally and [FLOOR_Y, FLOOR_Y + 2*ROOM] vertically.
const ROOM = 5.0;
const FLOOR_Y = -1.0;
const SLAB_T = 0.1; // slab half-thickness scale
const ROOM_COLOR: [number, number, number, number] = [0.73, 0.73, 0.73, 1];

// LearnOpenGL backpack (forgeax-engine-assets/learn-opengl/objects/backpack/
// backpack.gltf — vendored via `scripts/convert-objects.mjs` from the upstream
// LO `backpack.obj`, byte-determinism verified). Loaded as a SceneAsset and
// instantiated under a placement parent entity (scale + yaw + rest-on-floor),
// so the vendored gltf stays pristine. The gltfImporter already wired the
// diffuse / specular / normal sub-asset textures. THE SSAO showcase model.
const BACKPACK_SCENE_GUID = AssetGuid.parse('019f0414-203f-75e8-b952-c58b7b7ae04b');

// Backpack native bbox: extent ~3.7 x 4.6 x 3.5, min-y ~ -1.74. Scale 0.95,
// yaw 35deg so straps + side pockets catch the rim light, and lift so the
// bottom pouch rests on the floor (floor top = FLOOR_Y + SLAB_T).
const BACKPACK_SCALE = 0.95;
const BACKPACK_YAW = (35 * Math.PI) / 180;
// The native bbox min-y (-1.74) belongs to a dangling strap, not the bag body;
// the visible bottom pouch sits ~0.2 above it, so an empirical drop plants the
// pouch on the floor for a crisp contact-shadow seam.
const BACKPACK_POS_Y = FLOOR_Y + SLAB_T - -1.74 * BACKPACK_SCALE - 0.55;

// Single dim light-blue point light (LO `lightColor=(0.2,0.2,0.7)`).
const LIGHT_POS: [number, number, number] = [2.0, 4.0, 2.0];
const LIGHT_COLOR: [number, number, number] = [0.45, 0.45, 0.9];
const LIGHT_INTENSITY = 5.0;
const LIGHT_RANGE = 25.0;

// Skylight = the constant ambient term SSAO modulates (LO's `vec3(0.3) * AO`).
// Solid color (no cubemap) so it is live on frame 0 with no async IBL.
const SKYLIGHT_COLOR: [number, number, number] = [0.85, 0.85, 0.9];
const SKYLIGHT_INTENSITY = 0.7;

const FALSIFY = (() => {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    return url.searchParams.get('falsify') ?? '';
  }
  return '';
})();

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error("[learn-render 5.9 ssao] missing <canvas id='app'> in index.html");
}

const bootstrapPromise = bootstrap(canvas);
void bootstrapPromise.catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.9 ssao] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error('[learn-render 5.9 ssao] bootstrap error:', err);
});
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const ssaoEnabled = FALSIFY !== 'ssao-off';
  const appRes = await createApp(
    target,
    {
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        lighting: 'clustered',
        ssao: ssaoEnabled,
      },
    },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  exposeLearnRenderTestApp(app, target);
  console.warn(
    `[learn-render 5.9 ssao] backend=${app.renderer.inspect().capabilities.backendKind}`,
  );


  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.9 ssao] AssetRegistry is null');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Wire the __learnRenderErrors bus for onerror-gate coverage.
  const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
  if (bus !== undefined) {
    app.onError((error) => {
      bus.push({ code: error.code, hint: error.hint });
    });
  }

  const world = app.world;

  // Skylight: the constant ambient term SSAO modulates.
  world.spawn({
    component: Skylight,
    data: {
      color: [SKYLIGHT_COLOR[0], SKYLIGHT_COLOR[1], SKYLIGHT_COLOR[2]],
      intensity: SKYLIGHT_INTENSITY,
    },
  });

  // Enclosing room: 5 inward-facing slabs (floor, ceiling, back + 2 side walls).
  // All standard materials so they appear in the deferred g-buffer SSAO samples;
  // the wall/floor corners are the concave AO hot-spots.
  const roomMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: ROOM_COLOR, roughness: 0.95 }),
  );
  const CEIL_Y = FLOOR_Y + 2 * ROOM;
  const slabs: Array<{ pos: [number, number, number]; scale: [number, number, number] }> = [
    { pos: [0, FLOOR_Y, 0], scale: [ROOM, SLAB_T, ROOM] }, // floor
    { pos: [0, CEIL_Y, 0], scale: [ROOM, SLAB_T, ROOM] }, // ceiling
    { pos: [0, FLOOR_Y + ROOM, -ROOM], scale: [ROOM, ROOM, SLAB_T] }, // back wall
    { pos: [-ROOM, FLOOR_Y + ROOM, 0], scale: [SLAB_T, ROOM, ROOM] }, // left wall
    { pos: [ROOM, FLOOR_Y + ROOM, 0], scale: [SLAB_T, ROOM, ROOM] }, // right wall
  ];
  for (const s of slabs) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [s.pos[0], s.pos[1], s.pos[2]], quat: [0, 0, 0, 1], scale: [s.scale[0], s.scale[1], s.scale[2]],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [roomMat] } },
    ).unwrap();
  }

  // The SSAO showcase model: LearnOpenGL backpack, loaded as a SceneAsset and
  // instantiated. The gltfImporter already produced the SceneAsset + every
  // referenced mesh / material / texture sub-asset; the runtime resolves the
  // cross-refs transparently. Placement (scale + yaw + rest-on-floor) lives on
  // a parent entity passed to instantiate(), so the vendored gltf stays pristine
  // and transform propagation lands the whole 79-node tree at the contact seam.
  if (!BACKPACK_SCENE_GUID.ok) {
    console.error('[learn-render 5.9 ssao] invalid backpack scene GUID');
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(BACKPACK_SCENE_GUID.value);
  if (!sceneRes.ok) {
    console.error('[learn-render 5.9 ssao] loadByGuid<SceneAsset>(backpack) failed:', sceneRes.error.code, sceneRes.error.hint);
    if (bus !== undefined) bus.push({ code: sceneRes.error.code, hint: sceneRes.error.hint });
    return;
  }
  const placementRes = world.spawn({
    component: Transform,
    data: {
      pos: [0, BACKPACK_POS_Y, 0], quat: [0, Math.sin(BACKPACK_YAW / 2), 0, Math.cos(BACKPACK_YAW / 2)], scale: [BACKPACK_SCALE, BACKPACK_SCALE, BACKPACK_SCALE],},
  });
  if (!placementRes.ok) {
    console.error('[learn-render 5.9 ssao] backpack placement spawn failed:', placementRes.error);
    return;
  }
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world, placementRes.value);
  if (!instRes.ok) {
    const e = instRes.error as { code: string; hint?: string };
    console.error('[learn-render 5.9 ssao] backpack scene instantiate failed:', e.code, e.hint);
    if (bus !== undefined) bus.push({ code: e.code, ...(e.hint !== undefined ? { hint: e.hint } : {}) });
    return;
  }

  // Single dim light-blue point light (LO uses one light; ambient dominates).
  world.spawn(
    {
      component: Transform,
      data: { pos: [LIGHT_POS[0], LIGHT_POS[1], LIGHT_POS[2]], quat: [0, 0, 0, 1]},
    },
    {
      component: PointLight,
      data: {
        color: [LIGHT_COLOR[0], LIGHT_COLOR[1], LIGHT_COLOR[2]],
        intensity: LIGHT_INTENSITY,
        range: LIGHT_RANGE,
      },
    },
  );

  // Camera inside the room, looking at the rock so its crevices + the floor
  // contact + the room corners (the AO showcase) fill the frame. Pitched down.
  const pitch = -0.22;
  const qx = Math.sin(pitch / 2);
  const qw = Math.cos(pitch / 2);
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 2.2, 7.5], quat: [qx, 0, 0, qw]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 50 }),
        clearColor: [0.04, 0.04, 0.06, 1],
      },
    },
  ).unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[learn-render 5.9 ssao] running. SSAO=${ssaoEnabled ? 'enabled' : 'OFF'}. Enclosing room + backpack.gltf model + Skylight ambient + 1 dim light (LO 5.9 SSAO scene).`,
  );

  installCaptureHook(app, world, target);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + canvas capture so the live read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], canvas: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureSsao?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureSsao = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const r = await captureCanvasPixels(canvas);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.9 ssao] canvas capture failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.9 ssao] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 5.9 ssao] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureSsao?: () => Promise<Uint8Array>;
  }
}
