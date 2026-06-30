// apps/hello/culling — frustum-culling end-to-end demonstration (feat-20260528
// frustum-culling M5 / w13; extended in feat-20260608-mesh-ssbo-dynamic-grow
// M5 to also stress the SSBO grow path).
//
// Spawns a grid of 46 x 46 = 2116 cubes in a plane at z=0 spaced 3 units
// apart (-67.5 to +67.5 in X, Z). To exercise BOTH surfaces:
//   - half the grid (every other cube via (ix+iz)%2==0) keeps the default
//     `frustumCulled=1` so frustum culling stays observably active and the
//     `frustumStats.culled` counter still reports a non-zero value
//     (preserves the original demo's purpose);
//   - the other half opts out via `frustumCulled=0` so they always flow
//     through the per-entity SSBO writeBuffer pipeline regardless of camera
//     pose, guaranteeing `validatedOrdered.length` >= 1058 every frame.
//     1058 > 1024 forces the grow path to fire on the first draw
//     (1024 -> 2048; AC-11 + AC-12 dynamic grow stress).
// The camera has a narrow fov so the always-rendered half still falls
// outside it most of the time visually -- the grow happens because the
// SSBO sizes against `validatedOrdered.length`, not against camera-visible
// count.
//
// Four-step recipe (same as hello-cube):
//   (1) spawn grid entities
//   (2) await renderer.ready
//   (3) rAF loop with camera orbit + per-frame stats log
//   (4) frustumStats verified in smoke script

import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  acquireCanvasContext,
  createBoxGeometry,
  createRenderer,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const GRID_SIZE = 46;
const GRID_SPACING = 3;

const world = new World();

// Spawn DirectionalLight (no asset deps — can spawn before renderer ready)
world.spawn({
  component: DirectionalLight,
  data: {
    directionX: -0.5, directionY: -1, directionZ: -0.3,
    colorR: 1, colorG: 1, colorB: 1, intensity: 1,
  },
});

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-culling: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[culling] no usable backend:', err);
  else console.error('[culling] bootstrap error:', err);
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
      console.error('[culling] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.error('[culling] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[culling] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[culling] renderer.ready failed:', ready.error);
    return;
  }

  // Mint a custom cube mesh with known AABB as a user-tier shared ref. The
  // built-in HANDLE_CUBE uses engine-internal handle values; using
  // createBoxGeometry + allocSharedRef ensures AABB computation for culling.
  const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
  if (!boxResult.ok) {
    console.error('[culling] createBoxGeometry failed:', boxResult.error.code);
    return;
  }
  const cubeHandle = world.allocSharedRef('MeshAsset', boxResult.value);

  // Spawn cubes AFTER renderer is ready (mesh assets with AABB are registered).
  // Half the cubes keep `frustumCulled=1` (default) so the demo's culling
  // stat stays observably active; the other half opts out (frustumCulled=0)
  // to guarantee the SSBO grow path fires every run (M5 stress).
  for (let ix = 0; ix < GRID_SIZE; ix++) {
    for (let iz = 0; iz < GRID_SIZE; iz++) {
      const posX = (ix - (GRID_SIZE - 1) / 2) * GRID_SPACING;
      const posZ = (iz - (GRID_SIZE - 1) / 2) * GRID_SPACING;
      const culled = (ix + iz) % 2 === 0 ? 1 : 0;
      world.spawn(
        {
          component: Transform,
          data: {
            posX, posY: 0, posZ,
            quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
            scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7,
          },
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        { component: MeshRenderer, data: { frustumCulled: culled } },
      );
    }
  }

  // Spawn camera — positioned to see a subset of cubes
  const cameraEntity = world.spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 4, posZ: 6,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: { fov: Math.PI / 5, aspect: 16 / 9, near: 0.1, far: 30 },
    },
  ).unwrap();

  let angle = 0;
  const frame = (): void => {
    angle += 0.003;
    const camDist = 8;
    const camX = Math.sin(angle) * camDist;
    const camZ = Math.cos(angle) * camDist;

    // Orbit camera around the grid
    world.set(cameraEntity, Transform, {
      posX: camX, posY: 4, posZ: camZ,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    });

    const r = renderer.draw(world);
    if (!r.ok) console.error('[culling] draw error:', r.error);

    const stats = renderer.frustumStats;
    console.log(`[culling] culled=${stats.culled} total=${stats.total}`);

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}