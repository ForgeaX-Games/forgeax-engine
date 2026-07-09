// apps/hello/scene-nesting — importable SUT entry for browser smoke test.
//
// Exposed as `bootstrap(canvas)` so the browser test can import this module
// via `() => import('../index.ts')` (onerror-gate pattern). The demo's
// main.ts re-exports and self-calls bootstrap with the page's canvas.

import { ok, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  Materials,
  SceneInstance,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle, SceneAsset } from '@forgeax/engine-types';

export async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(canvas);
  console.log(`[hello-scene-nesting] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error(`[hello-scene-nesting] renderer.ready failed: ${ready.error.code}`);
    throw new Error(ready.error.hint);
  }

  const assets = renderer.assets;
  if (!assets) throw new Error('AssetRegistry is null');

  const world = new World();

  // Register built-in materials.
  const unlitMatGuid = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
  if (!unlitMatGuid.ok) throw new Error('unlit material GUID parse failed');
  assets.catalog(unlitMatGuid.value, Materials.unlit([0.8, 0.4, 0.2, 1]));

  // Catalog standard material GUID.
  const stdMatGuid = AssetGuid.parse('f6af7007-158f-4d92-9e47-93bf2f213e1f');
  if (!stdMatGuid.ok) throw new Error('standard material GUID parse failed');
  assets.catalog(stdMatGuid.value, {
    kind: 'material',
    passes: [
      { name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 },
    ],
    paramValues: { baseColor: [0.2, 0.3, 0.9], metallic: 0, roughness: 0.5 },
  });

  const innerCubeGuid = AssetGuid.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  if (!innerCubeGuid.ok) throw new Error('inner cube GUID parse failed');

  const outerSceneGuid = AssetGuid.parse('d07a7b8e-9c12-4f6b-a8e1-3d4f5a6b7c8d');
  if (!outerSceneGuid.ok) throw new Error('outer scene GUID parse failed');

  // Camera: position looking at the scene origin.
  world.spawn(
    { component: Transform, data: {
      posX: 0, posY: 1.5, posZ: 3,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    } },
    { component: Camera, data: { fov: 60, aspect: 800/600, near: 0.1, far: 100 } },
  );

  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.3, directionY: -1.0, directionZ: -0.5,
      colorR: 1.0, colorG: 0.95, colorB: 0.9, intensity: 1.0,
    },
  });

  const innerSceneRes = await assets.loadByGuid<SceneAsset>(innerCubeGuid.value);
  if (!innerSceneRes.ok) throw new Error(`inner scene loadByGuid failed: ${innerSceneRes.error.code}`);

  const outerSceneRes = await assets.loadByGuid<SceneAsset>(outerSceneGuid.value);
  if (!outerSceneRes.ok) throw new Error(`outer scene loadByGuid failed: ${outerSceneRes.error.code}`);

  // loadByGuid returns payloads (D-17); mint user-tier column handles.
  const innerSceneHandle = world.allocSharedRef('SceneAsset', innerSceneRes.value);
  const outerSceneHandle = world.allocSharedRef('SceneAsset', outerSceneRes.value);

  // Wire the sceneAssetResolver so mount.source can resolve the inner scene.
  // R2/F-3: _setSceneAssetResolver is @internal — AI users normally never
  // touch it because engine.assets.instantiate(...) auto-wires the
  // resolver. The demo wires manually here only because it loads BOTH
  // outer and inner separately to demonstrate the mount.source -> child
  // GUID flow; in idiomatic AI-user code a single
  // engine.assets.instantiate(outerHandle, world) call would suffice
  // (loadByGuid is recursive over scene refs[] per
  // tweak-20260609-asset-registry-instantiate-scene-by-guid).
  world._setSceneAssetResolver(
    (source: number | string, _parentHandle: Handle<'SceneAsset', 'shared'>) => {
      void source;
      return ok(innerSceneHandle);
    },
  );

  const instRes = assets.instantiate<SceneAsset>(outerSceneHandle, world);
  if (!instRes.ok) {
    console.error(`[hello-scene-nesting] instantiate failed: ${instRes.error.code}`);
    throw new Error(instRes.error.hint ?? 'instantiate failed');
  }
  const root = instRes.value;

  let instanceCount = 0;
  {
    const inst = world.get(root, SceneInstance);
    if (inst.ok) instanceCount += 1;
  }
  console.log(`[hello-scene-nesting] active SceneInstance roots: ${instanceCount}`);
  console.log(`[hello-scene-nesting] demo ready; root=${root}`);

  // Wire renderer.onError for the browser smoke gate.
  renderer.onError((err) => {
    const bus = (globalThis as unknown as Record<string, unknown>).__learnRenderErrors as unknown[] | undefined;
    if (bus !== undefined) bus.push(err);
    console.error('[hello-scene-nesting] renderer.onError:', err.code, err.hint);
  });

  function frame() {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error(`[hello-scene-nesting] draw error: ${r.error.code}`);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}