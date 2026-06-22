// apps/hello/physics — Physics integration demo using createApp physics opts.
//
// Three-statement takeoff (mirrors hello-app pattern):
//   const app = await createApp(canvas, { physics: 'rapier-3d' });
//   if (!app.ok) reportError(app.error);
//   app.value.start();
//
// Scene: static ground plane + dynamic sphere free-falling from y=5 with
// restitution-driven bounce. The physics engine drives Transform positions
// each frame through the physics tick systems (registered by createApp
// fire-and-forget WASM loader).
//
// Note: the physics backend is loaded asynchronously via fire-and-forget
// dynamic import (AC-09). Physics bodies are spawned before the WASM module
// finishes loading, so the first few frames may have no physics simulation
// — the sphere appears at y=5 and starts falling once the WASM module
// initialises.

import type { AppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import type { RhiError } from '@forgeax/engine-runtime';
import {
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  Transform,
  HANDLE_CUBE,
} from '@forgeax/engine-runtime';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-physics: missing <canvas id="app"> in index.html');

const app = await createApp(canvas, {
    physics: 'rapier-3d',
}, forgeaxBundlerAdapter());
if (!app.ok) reportError(app.error);
else {
  spawnScene(app.value.world);
  app.value.start();
}

function spawnScene(world: import('@forgeax/engine-ecs').World): void {
  // Ground: static cuboid at y=-2, wide enough to catch the falling sphere.
  world
    .spawn(
      {
        component: Transform,
        data: { posX: 0, posY: -2, posZ: 0, scaleX: 10, scaleY: 0.5, scaleZ: 10 },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.static },
      },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtentsX: 0.5,
          halfExtentsY: 0.5,
          halfExtentsZ: 0.5,
          restitution: 0.3,
        },
      },
    )
    .unwrap();

  // Dynamic sphere: starts at y=5, falls under gravity, bounces on ground.
  world
    .spawn(
      {
        component: Transform,
        data: { posX: 0, posY: 5, posZ: 0 },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      {
        component: RigidBody,
        data: {
          type: RigidBodyTypeValue.dynamic,
          mass: 1,
          linearDamping: 0.01,
        },
      },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.sphere,
          radius: 0.5,
          restitution: 0.7,
          friction: 0.5,
        },
      },
    )
    .unwrap();

  // Camera: positioned to observe the falling sphere. The view matrix is built
  // via mat4.lookAt, then inverted to obtain the camera world-space matrix.
  // mat4.decompose extracts the world-space rotation quaternion that, when fed
  // into the render-system's compose+invert path, reproduces the same view.
  const viewMatrix = mat4.create();
  mat4.lookAt(viewMatrix, vec3.create(8, 4, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
  const worldMatrix = mat4.create();
  mat4.invert(worldMatrix, viewMatrix);
  const camPos = vec3.create();
  const cameraQuat = quat.create();
  const camScale = vec3.create();
  mat4.decompose(camPos, cameraQuat, camScale, worldMatrix);
  world
    .spawn(
      { component: Transform, data: { posX: 8, posY: 4, posZ: 10, quatX: cameraQuat[0]!, quatY: cameraQuat[1]!, quatZ: cameraQuat[2]!, quatW: cameraQuat[3]! } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
    )
    .unwrap();

  // DirectionalLight: angled down so the ground + sphere are lit.
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.5,
      directionY: -1,
      directionZ: -0.3,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
    },
  }).unwrap();
}

function reportError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error(`[hello-physics] EngineEnvironmentError: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  switch (err.code) {
    case 'app-not-started':
    case 'app-already-running':
    case 'app-canvas-detached':
    case 'app-paused-while-stop':
    case 'app-system-update-failed':
    case 'adapter-unavailable':
    case 'feature-not-enabled':
    case 'limit-exceeded':
    case 'shader-compile-failed':
    case 'rhi-not-available':
    case 'webgpu-runtime-error':
    case 'command-encoder-finished':
    case 'render-pass-not-ended':
    case 'queue-submit-failed':
    case 'queue-write-buffer-out-of-bounds':
    case 'render-system-no-camera':
    case 'render-system-multi-camera':
    case 'render-system-multi-light':
    case 'asset-not-registered':
    case 'device-lost':
    case 'oom':
    case 'internal-error':
    case 'hierarchy-broken':
      console.error(`[hello-physics] ${err.code}: ${err.hint}`);
      return;
  }
}