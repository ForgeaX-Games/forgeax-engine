// apps/hello/picking — screen-to-entity picking end-to-end demonstration
// (feat-20260529-picking-raycasting-screen-to-entity M4 / w16).
//
// Spawns a single cube at the origin in front of a perspective camera. A DOM
// click listener unprojects the viewport-relative pointer coordinate into a
// world-space ray via the runtime `pick` free function and, on a hit, swaps the
// cube's `MeshRenderer.material` from the default grey to a bright highlight
// material. Clicking empty space (a miss) leaves the cube unchanged.
//
// Four-step recipe (same as hello-cube / hello-culling):
//   (1) await renderer.ready
//   (2) register a custom box mesh (createBoxGeometry -> world.allocSharedRef(...)) so the
//       AABB the ray-AABB test needs is present, plus two unlit materials
//   (3) spawn the cube + a perspective camera entity
//   (4) rAF draw loop + a `click` listener that calls `pick(...)` and highlights
//
// The canvas is a fixed 800x600 (index.html). DOM coordinate conversion lives
// here in the demo (the Renderer does not expose the canvas; requirements
// OOS-13): `e.clientX - rect.left` / `e.clientY - rect.top` maps the page-space
// pointer to the viewport-relative coordinate `pick` expects.

import { World } from '@forgeax/engine-ecs';
import { type MeshAsset } from '@forgeax/engine-assets-runtime';
import { acquireCanvasContext, Camera, createRenderer, DirectionalLight, EngineEnvironmentError, type MaterialAsset, Materials, MeshFilter, MeshRenderer, perspective, Transform } from '@forgeax/engine-runtime';
import { pick } from '@forgeax/engine-picking';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const world = new World();

// DirectionalLight has no asset deps; safe to spawn before the renderer is ready.
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1], intensity: 1,
  },
});

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-picking: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[picking] no usable backend:', err);
  else console.error('[picking] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok)
      console.error('[picking] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.error('[picking] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[picking] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[picking] renderer.ready failed:', ready.error);
    return;
  }

  // Custom cube mesh ensures AABB computation (the built-in HANDLE_CUBE uses
  // engine-internal handle values); the ray-AABB pick test reads MeshAsset.aabb.
  const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
  if (!boxResult.ok) {
    console.error('[picking] createBoxGeometry failed:', boxResult.error.code);
    return;
  }
  const cubeHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', boxResult.value);

  // Two unlit materials: default grey + bright highlight (swapped on a pick hit).
  const defaultHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.55, 0.55, 0.6, 1]),
  );
  const highlightHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1, 0.85, 0.1, 1]),
  );

  // Cube at the origin, bound to the default material.
  const cubeEntity = world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: { materials: [defaultHandle] } },
  ).unwrap();

  // Perspective camera looking down -Z at the cube.
  const cameraEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 4]},
    },
    {
      component: Camera,
      data: perspective({ fov: Math.PI / 4, aspect: target.width / target.height }),
    },
  ).unwrap();

  // Click -> pick -> highlight. DOM coordinate conversion (OOS-13) is done here.
  target.addEventListener('click', (e) => {
    const rect = target.getBoundingClientRect();
    const hit = pick(
      world,
      cameraEntity,
      e.clientX - rect.left,
      e.clientY - rect.top,
      target.width,
      target.height,
    );
    if (hit) {
      world.set(hit.entity, MeshRenderer, { materials: [highlightHandle] });
      console.log(`[picking] hit entity=${hit.entity} distance=${hit.distance.toFixed(3)}`);
    } else {
      world.set(cubeEntity, MeshRenderer, { materials: [defaultHandle] });
      console.log('[picking] miss (no entity under pointer)');
    }
  });

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[picking] draw error:', r.error);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
