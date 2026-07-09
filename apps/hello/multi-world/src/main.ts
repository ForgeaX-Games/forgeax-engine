// apps/hello/multi-world - composited multi-world rendering exemplar
// (feat-20260708-composited-multi-world-rendering M5 / AC-12 / m5-i1).
//
// What this demo proves (the AI-user-facing shape of the feature):
//   renderer.draw([worldA, worldB], { owner: 0 })
// merges renderables + lights from EVERY world into one frame, while cameras
// and singleton render resources come only from the owner world (index 0).
//
// Scene (deliberately asymmetric so the merge is observable):
//   world A (owner, index 0): perspective Camera + DirectionalLight + one lit
//       green box on the left. It owns the only camera and the only light.
//   world B (index 1): two lit boxes on the right (a red box + a blue box
//       offset upward). B has NO camera and NO light of its own.
//
// Because world B carries neither a camera nor a light, if the engine only
// rendered the owner world you would see the green box alone; and if lights
// were NOT merged across worlds, B's boxes would fall to ambient=0 (there is
// no skylight here) and render black. Seeing B's boxes lit is the visual proof
// of both-worlds-geometry-visible (AC-06) + cross-world-lighting (AC-04). The
// dawn-node smoke (scripts/smoke-dawn.mjs) asserts exactly this with dual
// pixel-readback probes.
//
// Bootstrap uses createRenderer directly (not createApp): createApp owns a
// single internal World and can only composite one world, whereas this demo
// must hand the renderer an explicit [worldA, worldB] array. This mirrors the
// hello-triangle / hello-room createRenderer + acquireCanvasContext path.
//
// OOS-4: no gizmo code — the feature only guarantees correct multi-world
// geometry + light compositing; gizmo picking/placement is a separate loop.

import { World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  Camera,
  createRenderer,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  type MaterialAsset,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// ── Scene SSOT lock values (paired with scripts/smoke-dawn.mjs) ──────────────
// Camera sits on +Z looking down -Z; boxes live on the z=0 plane. The left box
// (world A) and right boxes (world B) straddle NDC x=0 so the smoke's two pixel
// probes land on the two worlds' geometry respectively.
const CAMERA_Z = 6;
const BOX_SCALE = 1.4;
const BOX_X = 1.6;
// Lit box colours (linear RGBA). World A = green, world B = red + blue. Colours
// differ per world so the A/B probe reads a distinct dominant channel.
const A_GREEN: readonly [number, number, number, number] = [0.15, 0.8, 0.2, 1];
const B_RED: readonly [number, number, number, number] = [0.85, 0.15, 0.15, 1];
const B_BLUE: readonly [number, number, number, number] = [0.2, 0.3, 0.85, 1];

function litBox(
  world: World,
  color: readonly [number, number, number, number],
  posX: number,
  posY: number,
): void {
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: color, metallic: 0, roughness: 0.5 }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { posX, posY, posZ: 0, scaleX: BOX_SCALE, scaleY: BOX_SCALE, scaleZ: BOX_SCALE },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
}

// world A (owner): camera + directional light + one lit box on the left.
function buildWorldA(): World {
  const world = new World();
  litBox(world, A_GREEN, -BOX_X, 0);
  world
    .spawn(
      { component: Transform, data: { posZ: CAMERA_Z } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        directionX: -0.4,
        directionY: -0.7,
        directionZ: -1,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 1.4,
      },
    })
    .unwrap();
  return world;
}

// world B (non-owner): two lit boxes on the right, no camera, no light.
function buildWorldB(): World {
  const world = new World();
  litBox(world, B_RED, BOX_X, 0);
  litBox(world, B_BLUE, BOX_X, BOX_X);
  return world;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-multi-world: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[multi-world] no usable backend:', err);
  else console.error('[multi-world] bootstrap error:', err);
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
    if (!cfgResult.ok) console.error('[multi-world] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.error('[multi-world] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[multi-world] backend=${renderer.backend}`);

  const worldA = buildWorldA();
  const worldB = buildWorldB();

  renderer.onError((e) => console.error('[multi-world] renderer.onError:', e.code, e.hint));

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[multi-world] renderer.ready failed:', ready.error);
    return;
  }

  // Composite both worlds every frame; world A (index 0) is the owner.
  const frame = (): void => {
    const r = renderer.draw([worldA, worldB], { owner: 0 });
    if (!r.ok) console.error('[multi-world] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
