// apps/hello/level-switch/src/index.ts -- state-machine demo (feat-20260616 M7 / m7w1).
//
// Demonstrates the engine-state API end-to-end:
//   1. defineState('LevelId', ...) at module level
//   2. createApp(canvas) auto-wires registerStatesPlugin
//   3. loadByGuid<SceneAsset> loads tutorial + street-a scenes
//   4. OnEnter(LevelId,'tutorial') assets.instantiate + despawnOnExit on scene root
//   5. Spawn a cross-state player entity (red cube, MeshFilter + MeshRenderer, no scope)
//   6. Keyboard handler (1 -> tutorial, 2 -> street-a, 3 -> main-menu)
//   7. HUD div shows the current state variant name

import { createApp } from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';
import type { MaterialAsset, SceneAsset } from '@forgeax/engine-types';
import { defineState, setNextState, getState, addOnEnter, despawnOnExit } from '@forgeax/engine-state';
import type { StateTokenVariant } from '@forgeax/engine-state';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

export const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);

// Scene GUIDs — scenes are catalogued inline below via assets.catalog
// (parallel copy kept in sync with scripts/smoke-dawn.mjs); no sidecar files.
const TUTORIAL_GUID = '6a000001-0001-4000-a000-000000000001';
const STREET_A_GUID = '6a000002-0001-4000-a000-000000000002';

export async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  // M3 (w16): input:false opt-out deleted (D-6). Canvas form always attaches
  // input (D-2). This demo accepts input always-on — the state-switch keys
  // (1/2/3) continue to work via the InputSnapshot that inputPlugin provides.
  // Option (a) assemble-form migration was assessed but costs outweigh benefits
  // for a demo where input-always-on has zero correctness impact.
  const appResult = await createApp(canvas, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error(`[hello-level-switch] createApp failed:`, appResult.error);
    throw new Error('createApp failed');
  }
  const app = appResult.value;
  const { world } = app;

  console.log(`[hello-level-switch] backend=${app.renderer.backend}`);

  const assets = app.renderer.assets;
  if (!assets) throw new Error('AssetRegistry is null');

  // Register scene materials. tutorial floor = orange unlit, street-a floor =
  // blue standard-PBR. Handles feed the inline scene PODs below.
  // feat-20260614 M8/D-17: AssetRegistry register* deleted. catalog<T>(guid,
  // payload) stores the GUID->payload entry loadByGuid resolves; allocSharedRef
  // mints the user-tier column handle the scene PODs / MeshRenderer need.
  const unlitMatPayload = Materials.unlit([0.8, 0.4, 0.2, 1]);
  const unlitMatGuid = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
  if (!unlitMatGuid.ok) throw new Error('unlit material GUID parse failed');
  assets.catalog(unlitMatGuid.value, unlitMatPayload);
  const unlitMatHandle = world.allocSharedRef('MaterialAsset', unlitMatPayload);

  const stdMatPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      { name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 },
    ],
    paramValues: { baseColor: [0.2, 0.3, 0.9], metallic: 0, roughness: 0.5 },
  };
  const stdMatGuid = AssetGuid.parse('f6af7007-158f-4d92-9e47-93bf2f213e1f');
  if (!stdMatGuid.ok) throw new Error('standard material GUID parse failed');
  assets.catalog(stdMatGuid.value, stdMatPayload);
  const stdMatHandle = world.allocSharedRef('MaterialAsset', stdMatPayload);

  // Player material: red unlit for cross-state visibility.
  const playerMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 },
    ],
    paramValues: { baseColor: [0.9, 0.2, 0.2] },
  });

  // Load scene assets via GUID. The two scenes are registered inline as
  // SceneAsset PODs (kept in sync with the parallel copy in smoke-dawn.mjs)
  // so loadByGuid resolves on the browser dev-server pack path. tutorial =
  // orange unlit floor, street-a = blue standard-PBR floor; both reuse
  // HANDLE_CUBE geometry scaled flat. Inline registration before loadByGuid
  // is what the dev-server pack path needs; this demo wires no pluginPack.
  const FLOOR_TRANSFORM = {
    pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.1, 10],};

  const tutorialGuid = AssetGuid.parse(TUTORIAL_GUID);
  if (!tutorialGuid.ok) throw new Error('tutorial GUID parse failed');
  assets.catalog(tutorialGuid.value, {
    kind: 'scene',
    entities: [
      {
        localId: 0,
        components: {
          Transform: FLOOR_TRANSFORM,
          MeshFilter: { assetHandle: HANDLE_CUBE },
          MeshRenderer: { materials: [Number(unlitMatHandle)] },
        },
      },
    ],
  } as unknown as SceneAsset);
  const tutorialSceneRes = await assets.loadByGuid<SceneAsset>(tutorialGuid.value);
  if (!tutorialSceneRes.ok) throw new Error(`tutorial loadByGuid failed: ${tutorialSceneRes.error.code}`);

  const streetGuid = AssetGuid.parse(STREET_A_GUID);
  if (!streetGuid.ok) throw new Error('street-a GUID parse failed');
  assets.catalog(streetGuid.value, {
    kind: 'scene',
    entities: [
      {
        localId: 0,
        components: {
          Transform: FLOOR_TRANSFORM,
          MeshFilter: { assetHandle: HANDLE_CUBE },
          MeshRenderer: { materials: [Number(stdMatHandle)] },
        },
      },
    ],
  } as unknown as SceneAsset);
  const streetSceneRes = await assets.loadByGuid<SceneAsset>(streetGuid.value);
  if (!streetSceneRes.ok) throw new Error(`street-a loadByGuid failed: ${streetSceneRes.error.code}`);

  // Camera + light.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 2, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: Camera, data: { fov: 60, aspect: 800 / 600, near: 0.1, far: 100 } },
  );

  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.3, -1.0, -0.5],
      color: [1.0, 0.95, 0.9], intensity: 1.0,
    },
  });

  // Cross-state player entity: red cube (HANDLE_CUBE), no scope — persists
  // across all state transitions. Raised above the floor plane and enlarged
  // so it is clearly visible against the dark background in every level
  // screenshot (cross-state persistence is the headline visual). Its world
  // position never changes across transitions — only the floor material does.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 1.2, 1.5], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [playerMatHandle] } },
  );

  // OnEnter tutorial: instantiate scene, scope root for exit-cleanup.
  // feat-20260614 D-17: loadByGuid returns the SceneAsset payload; mint a fresh
  // user-tier column handle per entry via world.allocSharedRef so re-entering
  // the state after a prior despawnOnExit release works (a stale handle whose
  // ref despawnOnExit already released would fail shared-ref-released on
  // re-entry). assets.instantiate resolves the scene's GUID-string component
  // fields to fresh handles.
  addOnEnter(LevelId, 'tutorial', (w) => {
    const ir = assets.instantiate(w.allocSharedRef('SceneAsset', tutorialSceneRes.value), w);
    if (!ir.ok) {
      console.error(`[hello-level-switch] instantiate tutorial failed: ${ir.error.code}`);
      return;
    }
    const root = ir.value;
    despawnOnExit(w, root, LevelId, 'tutorial');
    console.log(`[hello-level-switch] tutorial scene spawned, root=${root}`);
  });

  // OnEnter street-a: instantiate scene, scope root for exit-cleanup.
  addOnEnter(LevelId, 'street-a', (w) => {
    const ir = assets.instantiate(w.allocSharedRef('SceneAsset', streetSceneRes.value), w);
    if (!ir.ok) {
      console.error(`[hello-level-switch] instantiate street-a failed: ${ir.error.code}`);
      return;
    }
    const root = ir.value;
    despawnOnExit(w, root, LevelId, 'street-a');
    console.log(`[hello-level-switch] street-a scene spawned, root=${root}`);
  });

  // DOM HUD: display current state variant name.
  const hud = document.createElement('div');
  hud.id = 'level-switch-hud';
  hud.style.cssText = [
    'position: absolute',
    'top: 16px',
    'left: 16px',
    'color: #fff',
    'font: 20px/1.4 system-ui, sans-serif',
    'padding: 8px 16px',
    'background: rgba(0,0,0,0.6)',
    'border-radius: 4px',
    'pointer-events: none',
    'z-index: 10',
  ].join('; ');
  const parentEl = canvas.parentElement;
  if (parentEl) {
    parentEl.style.position = 'relative';
    parentEl.appendChild(hud);
  }

  function refreshHud(): void {
    const s = getState(world, LevelId);
    hud.textContent = `Level: ${s.ok ? s.value : '???'}`;
  }

  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_level_switch_hud__: () => hud.textContent ?? '',
  });

  app.registerUpdate(() => {
    refreshHud();
  });

  // Keyboard handler: 1 -> tutorial, 2 -> street-a, 3 -> main-menu.
  // The map values are typed as the LevelId variant union, so a typo here is
  // a compile error (PF-1: setNextState narrows variant to the token union).
  function onKeyDown(e: KeyboardEvent): void {
    const map: Record<string, StateTokenVariant<typeof LevelId>> = {
      '1': 'tutorial',
      '2': 'street-a',
      '3': 'main-menu',
    };
    const variant = map[e.key];
    if (variant !== undefined) {
      const r = setNextState(world, LevelId, variant);
      if (!r.ok) {
        console.error(`[hello-level-switch] setNextState failed: ${r.error.code}`);
      }
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // Start the app.
  const startResult = app.start();
  if (!startResult.ok) {
    console.error(`[hello-level-switch] app.start failed: ${startResult.error.code}`);
  }
}