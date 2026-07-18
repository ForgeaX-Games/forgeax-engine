// apps/bevy/3d-scene - reproduction of Bevy's `3d_scene` example.
//
// Bevy source (references/repos/bevy/examples/3d/3d_scene.rs): "a simple 3D
// scene with light shining over a cube sitting on a plane" —
//   - a circular base plane, white StandardMaterial, rotated flat (-90 deg X)
//   - a unit cube, srgb_u8(124,144,255) StandardMaterial, at y=0.5
//   - a PointLight at (4,8,4), shadows enabled
//   - a Camera at (-2.5,4.5,9.0) looking at the origin
//
// forgeax mapping (thin over existing primitives, standard-PBR path — no
// pack.json / GUID plumbing; direct world.spawn like apps/hello/shadow-opt-out):
//   - base:  HANDLE_CUBE scaled flat (a plane primitive would work too; a flat
//            box keeps the demo to one mesh handle). White PBR material.
//   - cube:  HANDLE_CUBE at y=0.5. Blue PBR material (124,144,255)/255 in
//            linear-ish space — kept as authored sRGB-ish values for parity.
//   - light: Transform (4,8,4) + PointLight (standard-PBR needs >=1 light or
//            the render is physically black — runtime README Common pitfalls).
//   - cam:   Transform (-2.5,4.5,9.0) aimed at the origin via quat.fromLookAt
//            (the ergonomic camera helper — added in solo round 20260713-141636
//            to replace the mat4->invert->mat3->fromRotationMatrix hand-wiring
//            this demo originally used).

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  acquireCanvasContext,
  Camera,
  createRenderer,
  EngineEnvironmentError,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-3d-scene: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-3d-scene] no usable backend:', err);
  } else {
    console.error('[bevy-3d-scene] bootstrap error:', err);
  }
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
    if (!cfgResult.ok) console.error('[bevy-3d-scene] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.warn('[bevy-3d-scene] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[bevy-3d-scene] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-3d-scene] renderer.ready failed:', ready.error);
    return;
  }

  const world = new World();

  // ── Base plane (flat-scaled cube), white PBR ──────────────────────────
  const baseMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [8, 0.02, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [baseMat] } },
  );

  // ── Cube, blue PBR (Bevy srgb_u8(124,144,255)) at y=0.5 ───────────────
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [124 / 255, 144 / 255, 255 / 255, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  // ── Point light at (4,8,4) ────────────────────────────────────────────
  // standard-PBR is physically black with zero lights; a single PointLight
  // suffices (runtime README Common pitfalls). intensity=400 tuned against
  // Bevy's reference render: at ~9.8m the 1/d^2 falloff lands the near-white
  // lit plane + periwinkle cube that Bevy's default PointLight produces (round
  // 3's intensity=8 only cleared the not-black smoke threshold — a dark
  // workaround the round-4 screenshot-vs-Bevy check caught; see REPORT).
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // ── Camera at (-2.5,4.5,9.0) looking at origin ────────────────────────
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-2.5, 4.5, 9.0],
        quat: quat.fromLookAt(quat.create(), [-2.5, 4.5, 9.0], [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-3d-scene] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
