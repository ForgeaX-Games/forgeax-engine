// learn-render-first-person.ts -- first-person camera controls SSOT for
// apps/learn-render/2.lighting/ (1, 2, 3, 4, 5, 6). Exports addFirstPersonSystem
// (with optional flashlight SpotLight narrowing), createFirstPersonControls
// (override-backend bootstrap), plus pure helpers computeWasdDisplacement
// and createScrollFovAccumulator for unit testing.
//
// Tunables: PITCH_CLAMP_RAD (89 deg), MOUSE_SENSITIVITY (0.002),
// CAMERA_FOV_RADIANS (PI/4).
//
// Yaw/pitch -> quaternion via engine-math `quat.fromEuler(...,'YXZ')`;
// forward/right vectors are derived via `quat.transformVec3` from the
// quaternion (single SSOT — no hand-rolled Tait-Bryan formula). Yaw stays
// in LO math convention (yaw=-pi/2 looks -Z, +mouse-dx increases yaw); the
// LO->engine bridge `engineYaw = -(yaw + pi/2)` makes identity quaternion
// match the LO initial pose and aligns mouse-dx with camera-right.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { App, BundlerOptions, CanvasAppError } from '@forgeax/engine-app';
import { createApp, inputPlugin } from '@forgeax/engine-app';
import { Entity, World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, type InputBackend } from '@forgeax/engine-input';
import { quat, vec3 } from '@forgeax/engine-math';
import {
  Camera,
  createDevImportTransport,
  createRenderer,
  EngineEnvironmentError,
  SpotLight,
  Transform,
} from '@forgeax/engine-runtime';

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

export const CAMERA_SPEED_PER_SECOND = 2.5;
export const PITCH_CLAMP_RAD = (89 * Math.PI) / 180;
export const MOUSE_SENSITIVITY = 0.002;
export const CAMERA_FOV_RADIANS = Math.PI / 4;
export const FOV_MIN_DEG = 1;
export const FOV_MAX_DEG = 45;
export const FOV_INITIAL_DEG = 45;

// -------------------------------------------------------------------
// Pure math helpers (testable without ECS / renderer / WebGPU)
// -------------------------------------------------------------------

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WasdHeld {
  readonly w: boolean;
  readonly s: boolean;
  readonly a: boolean;
  readonly d: boolean;
  readonly q?: boolean;
  readonly e?: boolean;
}

export interface DisplacementXYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ScrollFovAccumulator {
  readonly fovDeg: number;
  readonly fovRad: number;
  apply(wheelDelta: number): void;
}

export function computeWasdDisplacement(
  dt: number,
  forward: Vec3Like,
  right: Vec3Like,
  held: WasdHeld,
  speedOverride?: number,
): DisplacementXYZ {
  const speed =
    (speedOverride !== undefined && speedOverride > 0 ? speedOverride : CAMERA_SPEED_PER_SECOND) *
    dt;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (held.w) {
    dx += forward.x * speed;
    dy += forward.y * speed;
    dz += forward.z * speed;
  }
  if (held.s) {
    dx -= forward.x * speed;
    dy -= forward.y * speed;
    dz -= forward.z * speed;
  }
  if (held.a) {
    dx -= right.x * speed;
    dz -= right.z * speed;
  }
  if (held.d) {
    dx += right.x * speed;
    dz += right.z * speed;
  }
  if (held.q) {
    dy -= speed;
  }
  if (held.e) {
    dy += speed;
  }
  return { x: dx, y: dy, z: dz };
}

export function createScrollFovAccumulator(): ScrollFovAccumulator {
  let fovDeg = FOV_INITIAL_DEG;
  const acc: ScrollFovAccumulator = {
    get fovDeg(): number {
      return fovDeg;
    },
    get fovRad(): number {
      return (fovDeg * Math.PI) / 180;
    },
    apply(wheelDelta: number): void {
      fovDeg -= wheelDelta;
      if (fovDeg < FOV_MIN_DEG) fovDeg = FOV_MIN_DEG;
      if (fovDeg > FOV_MAX_DEG) fovDeg = FOV_MAX_DEG;
    },
  };
  return acc;
}

// -------------------------------------------------------------------
// ECS system builder
// -------------------------------------------------------------------

export interface FirstPersonOptions {
  readonly name: string;
  readonly overrideBackend: InputBackend | undefined;
  readonly flashlight?: { readonly spotLightQuery: true };
  readonly moveSpeed?: number;
}

const FORWARD_LOCAL: Readonly<[number, number, number]> = [0, 0, -1];
const RIGHT_LOCAL: Readonly<[number, number, number]> = [1, 0, 0];

export function addFirstPersonSystem(
  world: App['world'],
  renderer: App['renderer'],
  opts: FirstPersonOptions,
): void {
  let yaw = -Math.PI / 2;
  let pitch = 0;

  const qTmp = quat.create();
  const forwardTmp = vec3.create();
  const rightTmp = vec3.create();

  const tick = (dt: number, snapshot: NonNullable<ReturnType<typeof renderer.input.snapshot>>) => {
    yaw += snapshot.mouse.movementDelta.x * MOUSE_SENSITIVITY;
    pitch -= snapshot.mouse.movementDelta.y * MOUSE_SENSITIVITY;
    if (pitch > PITCH_CLAMP_RAD) pitch = PITCH_CLAMP_RAD;
    if (pitch < -PITCH_CLAMP_RAD) pitch = -PITCH_CLAMP_RAD;
    quat.fromEuler(qTmp, pitch, -(yaw + Math.PI / 2), 0, 'YXZ');
    quat.transformVec3(forwardTmp, qTmp, FORWARD_LOCAL);
    quat.transformVec3(rightTmp, qTmp, RIGHT_LOCAL);
    const forward = { x: forwardTmp[0] ?? 0, y: forwardTmp[1] ?? 0, z: forwardTmp[2] ?? 0 };
    const right = { x: rightTmp[0] ?? 0, y: rightTmp[1] ?? 0, z: rightTmp[2] ?? 0 };
    const displacement = computeWasdDisplacement(
      dt,
      forward,
      right,
      {
        w: snapshot.keyboard.down('w'),
        s: snapshot.keyboard.down('s'),
        a: snapshot.keyboard.down('a'),
        d: snapshot.keyboard.down('d'),
        q: snapshot.keyboard.down('q'),
        e: snapshot.keyboard.down('e'),
      },
      opts.moveSpeed,
    );
    return { forward, displacement };
  };

  if (opts.flashlight) {
    world.addSystem({
      name: opts.name,
      after: ['input-frame-start-scan'],
      queries: [{ with: [Transform, Camera, Entity] }, { with: [Transform, SpotLight, Entity] }],
      fn: (world, queryResults) => {
        const snapshot = renderer.input.snapshot(world);
        if (snapshot === undefined) return;
        const time = world.getResource<{ readonly dt: number }>('Time');
        const dt = time?.dt ?? 0;
        const { forward, displacement } = tick(dt, snapshot);

        let camPosX = 0;
        let camPosY = 0;
        let camPosZ = 3;
        for (const bundles of queryResults[0]) {
          for (let i = 0; i < bundles.Entity.self.length; i++) {
            camPosX = (bundles.Transform.posX[i] ?? 0) + displacement.x;
            camPosY = (bundles.Transform.posY[i] ?? 0) + displacement.y;
            camPosZ = (bundles.Transform.posZ[i] ?? 0) + displacement.z;
            bundles.Transform.posX[i] = camPosX;
            bundles.Transform.posY[i] = camPosY;
            bundles.Transform.posZ[i] = camPosZ;
            bundles.Transform.quatX[i] = qTmp[0] ?? 0;
            bundles.Transform.quatY[i] = qTmp[1] ?? 0;
            bundles.Transform.quatZ[i] = qTmp[2] ?? 0;
            bundles.Transform.quatW[i] = qTmp[3] ?? 1;
          }
        }

        for (const bundles of queryResults[1]) {
          for (let i = 0; i < bundles.Entity.self.length; i++) {
            bundles.Transform.posX[i] = camPosX;
            bundles.Transform.posY[i] = camPosY;
            bundles.Transform.posZ[i] = camPosZ;
            bundles.SpotLight.directionX[i] = forward.x;
            bundles.SpotLight.directionY[i] = forward.y;
            bundles.SpotLight.directionZ[i] = forward.z;
          }
        }
      },
    });
  } else {
    world.addSystem({
      name: opts.name,
      after: ['input-frame-start-scan'],
      queries: [{ with: [Transform, Camera, Entity] }],
      fn: (world, queryResults) => {
        const snapshot = renderer.input.snapshot(world);
        if (snapshot === undefined) return;
        const time = world.getResource<{ readonly dt: number }>('Time');
        const dt = time?.dt ?? 0;
        const { displacement } = tick(dt, snapshot);

        for (const bundles of queryResults[0]) {
          for (let i = 0; i < bundles.Entity.self.length; i++) {
            bundles.Transform.posX[i] = (bundles.Transform.posX[i] ?? 0) + displacement.x;
            bundles.Transform.posY[i] = (bundles.Transform.posY[i] ?? 0) + displacement.y;
            bundles.Transform.posZ[i] = (bundles.Transform.posZ[i] ?? 0) + displacement.z;
            bundles.Transform.quatX[i] = qTmp[0] ?? 0;
            bundles.Transform.quatY[i] = qTmp[1] ?? 0;
            bundles.Transform.quatZ[i] = qTmp[2] ?? 0;
            bundles.Transform.quatW[i] = qTmp[3] ?? 1;
          }
        }
      },
    });
  }
}

// -------------------------------------------------------------------
// Override-backend bootstrap
// -------------------------------------------------------------------

export async function createFirstPersonControls(
  target: HTMLCanvasElement,
  overrideBackend: InputBackend,
  // feat-20260608-create-app-param-surface-trim / M3 / D-7: helper signature
  // accepts a BundlerOptions third-arg defaulting to the virtual-module
  // adapter PRE-MERGED with the dev import transport. Callers (LO 2.x
  // lighting + 6.pbr IBL demos) thus pass nothing or just adapter() and
  // still get `createDevImportTransport()` wired -- needed because every
  // override-backend demo path resolves raw-source textures through POST
  // /__import on a DDC miss; absent transport => `asset-not-imported`.
  bundler: BundlerOptions = {
    ...forgeaxBundlerAdapter(),
    importTransport: createDevImportTransport(),
  },
): Promise<{ ok: true; value: App } | { ok: false; error: CanvasAppError }> {
  try {
    const renderer = await createRenderer(target, {}, bundler);
    const world = new World();
    // M3 (w17): host pre-injects input backend BEFORE createApp so
    // inputPlugin.build finds INPUT_BACKEND_KEY and registers the scan system.
    world.insertResource(INPUT_BACKEND_KEY, overrideBackend);
    return createApp({ renderer, world, plugins: [inputPlugin()] });
  } catch (error: unknown) {
    if (error instanceof EngineEnvironmentError) {
      return { ok: false, error };
    }
    throw error;
  }
}
