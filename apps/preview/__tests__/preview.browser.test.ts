// preview.browser.test.ts -- e2e gate for the apps/preview host + the
// templates/game-default GameEntry it loads. Runs in the vitest `browser`
// project (chrome-beta + lavapipe, real WebGPU), so it covers the
// browser-only path that dawn-node smokes cannot: createApp's canvas form,
// the GameEntry's scene.pack.json fetch via import.meta.url, loadByGuid
// through the pluginPack dev-server middleware, and N frames of real draw.
//
// What it asserts (charter P3 explicit failure -- every gate is a hard
// expect, no silent skip):
//   - createApp(canvas) -> Result.ok(App)          (host wiring alive)
//   - the template GameEntry resolves without throw (scene pack loads)
//   - a Camera entity exists                        (dynamic layer ran)
//   - entityCount >= 21 (the pack's node count)     (scene pack instantiated,
//                                                     not the fallback path)
//   - zero renderer errors across N frames          (no WebGPU validation /
//                                                     device error)
//
// This mirrors apps/preview/src/main.ts's bootstrap, minus the two Vite
// build-time couplings a test runner cannot evaluate: `virtual:forgeax/
// bundler` (createApp works without it -- see thin-wrapper.browser.test.ts)
// and `import.meta.glob` (the template module is imported directly here).

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { createApp } from '@forgeax/engine-app';
import type { GameContext } from '@forgeax/engine-app';
import { createQueryState, Entity, queryRun } from '@forgeax/engine-ecs';
import { Camera, createDevImportTransport } from '@forgeax/engine-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import gameDefault from '../../../templates/game-default/main';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('apps/preview e2e -- templates/game-default loads + renders error-free', () => {
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    // The template reads `document.querySelector('#app')` and its
    // clientWidth/Height, so the canvas must be connected with a layout box.
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.style.width = '320px';
    canvas.style.height = '240px';
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    canvas.remove();
  });

  it('createApp + GameEntry + 10 frames instantiates the scene, a Camera, and zero renderer errors', async () => {
    const appRes = await createApp(canvas, {}, { importTransport: createDevImportTransport() });
    expect(appRes.ok).toBe(true);
    if (!appRes.ok) return;
    const app = appRes.value;

    const errors: string[] = [];
    app.onError((e: { code?: string }) => {
      errors.push(e.code ?? '<unknown>');
    });

    const assets = app.renderer.assets;
    assets.configurePackIndex('/pack-index.json');

    const ctx: GameContext = {
      world: app.world,
      assets,
      app,
      registerUpdate: (fn: (dt: number) => void) => app.registerUpdate(fn),
    };

    // The GameEntry awaits scene.pack.json fetch + loadByGuid; a throw here is
    // a real failure (stale pack schema, missing asset, broken instantiate).
    await gameDefault(ctx);

    const startRes = app.start();
    expect(startRes.ok).toBe(true);

    for (let i = 0; i < 10; i++) {
      await nextFrame();
    }
    app.stop();

    // Camera => the dynamic layer (camera + gameplay) executed.
    let cameraCount = 0;
    queryRun(createQueryState({ with: [Camera, Entity] }), app.world, (bundle) => {
      cameraCount += bundle.Entity.self.length;
    });
    expect(cameraCount).toBeGreaterThan(0);

    // Entity count => the authored scene pack instantiated rather than the
    // template falling back to spawnFallbackScene (which spawns only a single
    // ground entity). The pack authors 21 nodes; with camera + skylight +
    // skybox + ground collider + showcase props the live world is ~27. A
    // count well above the fallback's handful is the "scene loaded + its
    // localId mapping survived" signal -- the #1 "scene loads but is dead"
    // failure mode the template AGENTS.md warns about. (Name is a UniqueRef
    // string component, not a queryable column, so we count entities rather
    // than query for the "Player" name.)
    const entityCount = app.world.inspect().entityCount;
    expect(
      entityCount,
      `only ${entityCount} entities -- scene pack failed to instantiate (fallback path)`,
    ).toBeGreaterThanOrEqual(21);

    // The headline gate: a full createApp -> entry -> N-frame run with no
    // SUT-attributable renderer error. We filter to SUT_ATTRIBUTABLE_CODES
    // (the same allow-list apps/shared/onerror-gate.ts uses) so the gate fires
    // on real validation/render faults (shader-compile-failed, asset-not-*,
    // render-system-no-camera, ...) but NOT on `device-lost` -- which in the
    // batched vitest browser runner is an environmental teardown artifact: a
    // sibling test's renderer.dispose() destroys the shared WebGPU device and
    // that loss fans out to every live app's onError. (We also do NOT dispose
    // the renderer here, to avoid being that polluting sibling.)
    const sutErrors = errors.filter((c) => SUT_ATTRIBUTABLE_CODES.has(c));
    expect(sutErrors, `SUT renderer errors: ${sutErrors.join(', ')}`).toEqual([]);
  });
});
