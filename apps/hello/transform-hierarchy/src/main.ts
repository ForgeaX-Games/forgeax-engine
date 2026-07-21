import { Update } from '@forgeax/engine-ecs';
// apps/hello/transform-hierarchy -- ChildOf hierarchy "parent moves, child
// follows" visual exemplar
// (feat-20260531-render-consume-global-transform-hierarchy / M3 / w12).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createRenderer + new World() (NOT createApp) -- the explicit path
//     that lets the demo own component registration + the propagate wiring.
//   - registerPropagateTransforms(world) -- this wires the per-frame kernel
//     that derives every entity's resolved Transform.world mat4 (root: world =
//     compose(local); child: world = parent.world x compose(local)). The
//     Transform.world column is always present (feat-20260601 unified Transform),
//     so a ChildOf entity follows its parent with no extra component to
//     register (plan-strategy D-3).
//   - A non-identity parent (pos x shifted) + a child entity carrying
//     ChildOf{parent} + Transform (local offset) + MeshFilter + MeshRenderer.
//     The child's Transform.world = parent.world x child-local, so moving the
//     parent at runtime drags the child across the screen.
//   - Runtime parent move: a frame system slides the parent back and forth
//     along +X via world.set(parent, Transform). The next world.update(1 / 60).unwrap()
//     runs propagateTransforms, the extract stage reads the child's refreshed
//     Transform.world, and the child moves with the parent. The dual-frame
//     smoke (scripts/smoke-dawn.mjs) is the machine-checkable proof of this;
//     this demo is the human/orchestrator visual confirmation surface
//     (charter P5 produce/consume split).
//
// Scene: one parent cube (offset +X, the "anchor") and one child cube
// (ChildOf the parent, local offset +Y) so the pair reads as a vertical
// stack that translates together when the parent moves. A static reference
// sphere sits off to the side and is NOT part of the hierarchy, giving the
// eye (and the smoke's stability check) a fixed landmark.

import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Camera, ChildOf, createRenderer, DirectionalLight, EngineEnvironmentError, MeshFilter, MeshRenderer, perspective, registerPropagateTransforms, Transform } from '@forgeax/engine-runtime';

import { World } from '@forgeax/engine-ecs';

import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[transform-hierarchy] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[transform-hierarchy] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[transform-hierarchy] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createRenderer (explicit path; no createApp).
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  console.warn(`[transform-hierarchy] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[transform-hierarchy] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  // Step 2: wire the propagate kernel. The registerPropagateTransforms line
  // is the whole point of this demo -- it derives every entity's
  // Transform.world each frame so the ChildOf entity follows its parent (the
  // world mat4 lives on Transform; defineComponent makes every component
  // usable, so spawn is direct with no per-World registration).
  const world = new World();

  registerPropagateTransforms(world);

  // Step 3: register the standard PBR material shared by every body.
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  } as MaterialAsset);

  // Step 4: spawn the hierarchy. Parent is non-identity (offset -0.6 on X).
  const parent = world
    .spawn(
      {
        component: Transform,
        data: { pos: [-0.6, -0.4, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Child carries ChildOf{parent} + a local +Y offset. Its world position is
  // parent.world x child-local, so it sits above the parent and translates
  // with it. scale is local (multiplied by the parent's 0.4).
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 2.0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      { component: ChildOf, data: { parent } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Static reference sphere -- NOT in the hierarchy. A fixed landmark so the
  // viewer (and the smoke stability check) has something that stays put.
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [1.4, 0.0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Step 5: directional light.
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -0.6, -0.7],
        color: [1, 1, 1],
        intensity: 1.5,
      },
    })
    .unwrap();

  // Step 6: camera.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 7]} },
      {
        component: Camera,
        data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
      },
    )
    .unwrap();

  // Step 7: a frame system slides the parent left<->right along X. The slide
  // runs as an unconstrained system and the parent's NEXT-frame Transform.world
  // picks up the change -- a one-frame latency that is invisible at rAF rates
  // and keeps the demo's data flow obvious (Transform write -> next-frame
  // propagate -> extract). The child's world position tracks the parent every
  // frame, so the stack visibly translates together.
  const hudEl = document.getElementById('th-hud');
  let phase = 0;

  world.addSystem(Update, {
    name: 'transform-hierarchy-parent-slide',
    queries: [],
    fn: () => {
      phase += 0.02;
      const parentX = -0.6 + 1.2 * Math.sin(phase);
      const setRes = world.set(parent, Transform, { pos: [parentX, 0, 0]});
      if (setRes.ok) {
        if (hudEl) hudEl.textContent = `parent.pos[0] = ${parentX.toFixed(2)} (child follows)`;
      } else {
        // charter P3: surface the failure rather than silently dropping it.
        console.error('[transform-hierarchy] parent move world.set failed:', setRes.error.code);
      }
    },
  });

  // Step 8: rAF loop. world.update(1 / 60).unwrap() runs the schedule (propagateTransforms +
  // the parent-slide system) before each draw.
  function frame(): void {
    world.update(1 / 60).unwrap();
    const draw = renderer.draw([world], { owner: 0 });
    if (!draw.ok) {
      console.error('[transform-hierarchy] draw failed:', draw.error.code);
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  console.warn('[transform-hierarchy] running. Parent slides automatically; child follows.');
}
