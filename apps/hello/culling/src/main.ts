// apps/hello/culling — frustum-culling end-to-end demonstration
// (feat-20260528-frustum-culling M5 / w13).
//
// Spawns a GRID_SIZE x GRID_SIZE plane of cubes at y=0 and orbits a
// narrow-fov camera around them. Frustum culling runs unconditionally in the
// extract stage: every cube whose world-space AABB falls entirely outside the
// view frustum is dropped, so `frustumStats.culled` stays non-zero every
// frame while the orbit keeps most of the grid off-screen.
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
  createRenderer,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { createBoxGeometry } from '@forgeax/engine-geometry';
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
  // Frustum culling is unconditional: every cube outside the camera frustum is
  // dropped in the extract stage, so the culling stat stays observably active.
  for (let ix = 0; ix < GRID_SIZE; ix++) {
    for (let iz = 0; iz < GRID_SIZE; iz++) {
      const gx = (ix - (GRID_SIZE - 1) / 2) * GRID_SPACING;
      const gz = (iz - (GRID_SIZE - 1) / 2) * GRID_SPACING;
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [gx, 0, gz],
            quat: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7],},
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      );
    }
  }

  // Spawn camera — positioned to see a subset of cubes
  const cameraEntity = world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 4, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
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
      pos: [camX, 4, camZ], quat: [0, 0, 0, 1], scale: [1, 1, 1],});

    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[culling] draw error:', r.error);

    const stats = renderer.frustumStats;
    console.log(`[culling] culled=${stats.culled} total=${stats.total}`);

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
