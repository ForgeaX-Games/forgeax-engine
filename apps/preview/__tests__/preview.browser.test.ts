// preview.browser.test.ts -- e2e gate for the apps/preview host + the
// templates/game-default bootstrap entry it loads. Runs in the vitest `browser`
// project (chrome-beta + lavapipe, real WebGPU), so it covers the
// browser-only path that dawn-node smokes cannot: createApp's canvas form,
// the bootstrap entry's scene load by GUID (forge.json.defaultScene ->
// loadByGuid<SceneAsset>) through the pluginPack dev-server middleware (which
// indexes assets/scene.pack.json), and N frames of real draw.
//
// What it asserts (charter P3 explicit failure -- every gate is a hard
// expect, no silent skip):
//   - createApp(canvas) -> Result.ok(App)          (host wiring alive)
//   - the template bootstrap resolves without throw (scene pack loads)
//   - a Camera entity exists                        (dynamic layer ran)
//   - entityCount >= 21 (the pack's node count)     (scene pack instantiated,
//                                                     not the fallback path)
//   - zero renderer errors across N frames          (no WebGPU validation /
//                                                     device error)
//
// This mirrors apps/preview/src/main.ts's bootstrap, minus the two Vite
// build-time couplings a test runner cannot evaluate: `virtual:forgeax/
// bundler` (createApp works without it -- see thin-wrapper.browser.test.ts)
// and `import.meta.glob` (the template module is imported directly here, and
// its `bootstrap` named export is invoked as bootstrap(world, ctx)).

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { createApp } from '@forgeax/engine-app';
import type { BootstrapContext } from '@forgeax/engine-app';
import { AudioSource } from '@forgeax/engine-audio';
import { audioPlugin } from '@forgeax/engine-audio-webaudio';
import { createQueryState, Entity, queryRun } from '@forgeax/engine-ecs';
import type { InputBackend, InputSnapshot } from '@forgeax/engine-input';
import { physicsPlugin } from '@forgeax/engine-physics';
import { Camera, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap } from '../../../templates/game-default/main';
import { HUD_UI_GUID } from '../../../templates/game-default/assets/plugins/hud';
import { SETTINGS_UI_GUID } from '../../../templates/game-default/assets/plugins/settings';
import { HIT_FLASH_SHADER_ID } from '../../../templates/game-default/assets/plugins/hit-flash-material';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('apps/preview e2e -- templates/game-default loads + renders error-free', () => {
  let canvas: HTMLCanvasElement;
  let viewport: HTMLDivElement;
  let activeApp: { stop(): unknown } | undefined;

  beforeEach(() => {
    // The template reads `document.querySelector('#app')` and its
    // clientWidth/Height, so the canvas must be connected with a layout box.
    viewport = document.createElement('div');
    viewport.style.position = 'relative';
    viewport.style.width = '320px';
    viewport.style.height = '240px';
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.style.width = '320px';
    canvas.style.height = '240px';
    viewport.appendChild(canvas);
    document.body.appendChild(viewport);
  });

  afterEach(() => {
    activeApp?.stop();
    activeApp = undefined;
    viewport.remove();
  });

  it('createApp + bootstrap + 10 frames instantiates the scene, a Camera, and zero renderer errors', async () => {
    // Browser workers may reuse a page across files; clear any backend left by
    // a neighboring fixture before attaching this test's input backend.
    window.dispatchEvent(new Event('blur'));
    const heldKeys = new Set<string>();
    const inputBackend: InputBackend = {
      sample: () => ({
        downKeys: new Set(heldKeys),
        upKeys: new Set<string>(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      detach: () => {},
    };
    const appRes = await createApp(
      canvas,
      { input: inputBackend, plugins: [audioPlugin(), physicsPlugin('rapier-3d')] },
      { importTransport: createDevImportTransport() },
    );
    expect(appRes.ok).toBe(true);
    if (!appRes.ok) return;
    const app = appRes.value;
    activeApp = app;

    const errors: string[] = [];
    const uiFailures: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(String).join(' ');
      if (text.includes('UI load failed')) uiFailures.push(text);
      originalError(...args);
    };
    app.onError((e: { code?: string }) => {
      errors.push(e.code ?? '<unknown>');
    });

    const assets = app.renderer.assets;
    assets.configurePackIndex('/pack-index.json');

    const uiRoot = document.createElement('div');
    uiRoot.dataset.testUiRoot = 'preview-bootstrap';
    viewport.appendChild(uiRoot);
    const ctx: BootstrapContext = { assets, app, renderer: app.renderer, uiRoot };

    // bootstrap(world, ctx) awaits the scene loadByGuid<SceneAsset> +
    // instantiate; a throw here is a real failure (stale pack schema, missing
    // asset, broken instantiate).
    try {
      await bootstrap(app.world, ctx);
    } finally {
      console.error = originalError;
    }
    expect(uiFailures, `template UI load failures: ${uiFailures.join('; ')}`).toEqual([]);

    const hudHost = uiRoot.querySelector<HTMLElement>(`[data-ui-asset="${HUD_UI_GUID}"]`);
    const settingsHost = uiRoot.querySelector<HTMLElement>(`[data-ui-asset="${SETTINGS_UI_GUID}"]`);
    expect(hudHost, 'bootstrap must mount the HUD UiAsset').not.toBeNull();
    expect(settingsHost, 'bootstrap must mount the settings UiAsset').not.toBeNull();
    const hudShadow = hudHost?.shadowRoot;
    const settingsShadow = settingsHost?.shadowRoot;
    expect(hudShadow, 'HUD mount must expose an open ShadowRoot').not.toBeNull();
    expect(settingsShadow, 'settings mount must expose an open ShadowRoot').not.toBeNull();
    expect(hudShadow?.querySelector('[data-ui-slot="score"]')?.textContent).toContain('Score');
    expect(hudShadow?.querySelector('[data-ui-slot="hint"]')).not.toBeNull();
    expect(hudShadow?.querySelector('[data-ui-action="open-settings"]')?.textContent).toContain('Settings');
    const dialog = settingsShadow?.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('settings-title');
    expect(settingsShadow?.querySelector('[data-ui-setting="music"]')).not.toBeNull();
    expect(settingsShadow?.querySelector('[data-ui-setting="high-contrast"]')).not.toBeNull();
    expect(settingsShadow?.querySelector('[data-ui-setting="antialias"]')).not.toBeNull();
    const audioEntities: number[] = [];
    queryRun(createQueryState({ with: [AudioSource, Entity] }), app.world, (bundle) => {
      audioEntities.push(...bundle.Entity.self);
    });
    expect(audioEntities.length, 'bootstrap must attach a player-owned AudioSource').toBeGreaterThan(0);
    expect(
      [...app.renderer.shader.materialShaderIdentifiers()],
      'bootstrap must register the template custom WGSL material',
    ).toContain(HIT_FLASH_SHADER_ID);
    const source = app.world.get(audioEntities[0]!, AudioSource);
    expect(source.ok).toBe(true);
    const openSettings = hudShadow?.querySelector<HTMLButtonElement>('[data-ui-action="open-settings"]');
    expect(openSettings).not.toBeNull();
    openSettings?.click();
    expect(dialog?.hidden).toBe(false);
    const closeSettings = settingsShadow?.querySelector<HTMLButtonElement>('[data-ui-action="close-settings"]');
    expect(closeSettings).not.toBeNull();
    closeSettings?.click();
    expect(dialog?.hidden).toBe(true);

    const readCameraX = (): number => {
      let x = 0;
      queryRun(createQueryState({ with: [Camera, Entity] }), app.world, (bundle) => {
        for (const entity of bundle.Entity.self) {
          const tr = app.world.get(entity, Transform);
          if (tr.ok) x = tr.value.pos[0] ?? 0;
        }
      });
      return x;
    };
    const tickWorld = (): void => {
      const updateRes = app.world.update(1 / 60);
      expect(updateRes.ok).toBe(true);
    };
    const initialCameraX = readCameraX();
    // Drive the world directly so action edges are observed in the same tick
    // as the injected backend sample; a live RAF would make a one-frame edge
    // race the test callback.
    heldKeys.delete('d');
    heldKeys.delete('D');
    tickWorld();
    // Rapier 3D builds the authored Player body on the first physics sync;
    // warm a few host ticks before asserting movement so the KCC readiness
    // boundary is observed rather than racing async WASM setup.
    for (let i = 0; i < 5; i++) tickWorld();
    heldKeys.add('d');
    tickWorld();
    const movementSnapshot = app.world.getResource<InputSnapshot>('InputSnapshot');
    const movementInputSeen = movementSnapshot?.action('moveRight').isPressed() ?? false;
    const movedCameraX = readCameraX();
    heldKeys.delete('d');
    expect(movementInputSeen).toBe(true);
    expect(Math.abs(movedCameraX - initialCameraX)).toBeGreaterThan(0.00001);
    tickWorld();
    // Normalize the injected backend before proving the reset edge.
    heldKeys.delete('r');
    heldKeys.delete('R');
    tickWorld();
    heldKeys.add('r');
    tickWorld();
    const resetSnapshot = app.world.getResource<InputSnapshot>('InputSnapshot');
    expect(resetSnapshot?.action('reset').justPressed()).toBe(true);
    heldKeys.delete('r');
    heldKeys.delete('R');
    tickWorld();
    const resetCameraX = readCameraX();
    expect(Math.abs(resetCameraX - initialCameraX)).toBeLessThan(Math.abs(movedCameraX - initialCameraX));

    const startRes = app.start();
    expect(startRes.ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      await nextFrame();
    }
    activeApp?.stop();
    activeApp = undefined;

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

    // The authored scene also mounts the reusable NestedTarget prefab into
    // localId 24. Verify the mount window and its field override survived the
    // public loadByGuid -> instantiate path, rather than only counting entities.
    const sceneRoots: number[] = [];
    queryRun(createQueryState({ with: [SceneInstance, Entity] }), app.world, (bundle) => {
      sceneRoots.push(...bundle.Entity.self);
    });
    expect(sceneRoots.length, 'default scene must expose a SceneInstance root').toBeGreaterThan(0);
    const sceneInstance = app.world.get(sceneRoots[0]!, SceneInstance);
    expect(sceneInstance.ok).toBe(true);
    if (sceneInstance.ok) {
      const nestedEntity = sceneInstance.value.mapping[24];
      expect(nestedEntity, 'nested prefab member localId 24 must be live').not.toBe(0xffffffff);
      if (nestedEntity !== undefined && nestedEntity !== 0xffffffff) {
        expect(app.world.get(nestedEntity, MeshRenderer).ok).toBe(true);
        const nestedTransform = app.world.get(nestedEntity, Transform);
        expect(nestedTransform.ok).toBe(true);
        expect(nestedTransform.ok && nestedTransform.value.scale[0]).toBeCloseTo(0.7, 5);
      }
    }

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
  }, 60_000);

});
