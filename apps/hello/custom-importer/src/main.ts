// apps/hello/custom-importer -- end-to-end acceptance demo for
// feat-20260629-importer-self-declared-fold-contract (M5 / w15).
//
// What this app proves (the whole feat in one screen):
//
//   declare -> import (source transform) -> build -> pack-index -> loadByGuid
//   -> real scene use, ALL for a HOST-defined kind the engine never knew about.
//
// The 4-step host-importer recipe (charter F1 progressive disclosure; mirrored
// in skills/forgeax-engine-assets/SKILL.md after this feat):
//
//   (1) declare `.meta.json` with `importer: 'reel-game-blob'` +
//       `subAssets[].kind: 'reel-game-blob'` (assets/level-1.reel.json.meta.json).
//   (2) inject the host importer via `pluginPack({ importers })` (vite.config.ts).
//   (3) register the host loader on `engine.assets.loaders.register(...)` (below).
//   (4) `loadByGuid<ReelGameBlob>(guid)` returns the typed payload; the host
//       drives the scene from it (below).
//
// OOS-1: the engine does NOT render the host kind. The host loader returns the
// blob; THIS file maps each reel in the blob to a visible cube (built-in unlit
// material via the empty-MeshRenderer default). The engine only sees cubes +
// camera + light -- the reel-game semantics live entirely host-side.

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, createDevImportTransport, DirectionalLight, EngineEnvironmentError, MeshFilter, MeshRenderer, perspective, Transform } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import { type ReelGameBlob, REEL_GAME_LEVEL_1_GUID } from './reel-game-blob';
import { reelGameBlobLoader } from './reel-game-blob-loader';

const PACK_INDEX_URL = '/pack-index.json';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[custom-importer] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  console.error('[custom-importer] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[custom-importer] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[custom-importer] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[custom-importer] AssetRegistry is null (renderer construction failed)');
    return;
  }

  // Step 3: register the host loader for the custom kind. This is the runtime
  // mirror of the build-time importer; the engine carries zero knowledge of
  // 'reel-game-blob' -- the host owns both ends (AC-05 / OOS-1).
  assets.loaders.register(reelGameBlobLoader());
  assets.configurePackIndex(PACK_INDEX_URL);

  // Step 4: loadByGuid<ReelGameBlob> resolves through the production fetch
  // chain: pack-index.json -> the importer-folded .pack.json -> the host
  // loader. The payload is the host type without an `as Asset` cast leaking
  // into the engine's closed union.
  const blob = await loadReelGameBlob(assets);
  if (blob === undefined) {
    console.error('[custom-importer] reel-game blob did not load; scene will be empty');
  } else {
    console.warn(
      `[custom-importer] loaded reel-game blob title=${JSON.stringify(blob.title)} reels=${blob.reels.length}`,
    );
    populateSceneFromBlob(app.world, blob);
  }

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[custom-importer] running.');
}

async function loadReelGameBlob(assets: {
  loadByGuid<T>(guid: AssetGuid): Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
}): Promise<ReelGameBlob | undefined> {
  const guidRes = AssetGuid.parse(REEL_GAME_LEVEL_1_GUID);
  if (!guidRes.ok) {
    console.error('[custom-importer] REEL_GAME_LEVEL_1_GUID parse failed:', guidRes.error.code);
    return undefined;
  }
  const res = await assets.loadByGuid<ReelGameBlob>(guidRes.value);
  if (!res.ok) {
    console.error('[custom-importer] loadByGuid failed:', res.error);
    return undefined;
  }
  return res.value;
}

// OOS-1 boundary: the engine does not understand reel-game semantics. The host
// turns each reel into a visible cube at the reel's world-X anchor (Y staggered
// by symbol count so the 3 reels read as distinct entities). The engine only
// ever sees cubes + camera + light.
function populateSceneFromBlob(world: World, blob: ReelGameBlob): void {
  for (const reel of blob.reels) {
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [reel.x, (reel.symbols.length - 2) * 0.2, 0]},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  }

  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3]} },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    )
    .unwrap();

  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
      },
    })
    .unwrap();
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error('[custom-importer] no usable WebGPU backend:', err);
    return;
  }
  console.error(`[custom-importer] ${err.code}: ${err.hint}`);
}
