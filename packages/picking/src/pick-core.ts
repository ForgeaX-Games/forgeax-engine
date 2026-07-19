// pick-core.ts — shared picking skeleton for pick() / pickVertex*() (feat-20260705 M2 M0).
//
// `pick.ts` (screen-to-entity ray-AABB) and `pick-vertex.ts` (vertex-level) share a
// verbatim skeleton (F11): the internal `Transform.world` view type, the archetype
// shape exposed by `_getGraph()`, the `readWorldMatrix` reader, and the
// camera-validation → view=invert(worldMatrix) → projection-branch → screenToRay
// sequence. This module is the single source of truth for that skeleton
// (architecture-principles §2 Derive, Don't Duplicate; AC-201). pick.ts and
// pick-vertex.ts import from here rather than each maintaining their own copy.
//
// Error channel (charter P3): a `cameraEntity` that carries no `Camera` is the one
// unrecoverable precondition — `computeScreenRay` throws a structured `PickError`
// (`code: 'camera-component-missing'`). A camera entity that carries no resolvable
// `Transform.world` is a degenerate miss (no view matrix can be built) — signalled by
// a `undefined` return, which callers translate to their own miss shape
// (`undefined` for pick, `[]`/`undefined` for the vertex queries).

import type { Component, EntityHandle, FieldView, World } from '@forgeax/engine-ecs';
import { mat4, ray } from '@forgeax/engine-math';
import {
  Camera,
  type CameraProjection,
  cameraProjectionFromF32,
  Transform,
} from '@forgeax/engine-runtime';
import { PickError } from './pick-errors';

/**
 * Internal world surface used by picking for the resolved `Transform.world` view.
 *
 * @internal Column-level zero-copy view of an `array<T, N>` / `buffer<N>` field.
 * Returns a `FieldView` (a TypedArray) aliasing the inline stride-N column bytes;
 * picking reads the resolved `Transform.world` mat4 through it (a `Float32Array` in
 * practice, feat-20260602 inline columns). The return type is the generic
 * `FieldView` because the underlying column may store any element type;
 * `new Float32Array(view)` below reinterprets the world mat4 from whichever
 * TypedArray backs it. `undefined` when the entity is dead or the column absent.
 */
export type WorldInternalView = World & {
  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined;
};

/** Minimal shape of an archetype as exposed by the engine-internal `_getGraph()`. */
export interface ArchetypeLike {
  size: number;
  components: ReadonlyArray<{ readonly id: number }>;
  columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
}

/**
 * Read an entity's resolved world mat4 (16 column-major floats) from the
 * `Transform.world` column array view (feat-20260601 D-3). Returns a fresh
 * copy (the view aliases live slot bytes); `undefined` when the entity has no
 * Transform / world column.
 */
export function readWorldMatrix(
  world: WorldInternalView,
  entity: EntityHandle,
): Float32Array | undefined {
  const view = world._getArrayView(entity, Transform, 'world');
  if (view === undefined) return undefined;
  return new Float32Array(view);
}

/**
 * The screen-to-world ray plus the camera matrices used to build it.
 *
 *   - `ray`            — the unprojected world-space pick ray (origin + direction).
 *   - `view`           — `invert(camera Transform.world)`.
 *   - `proj`           — the camera projection matrix (perspective / orthographic).
 *   - `projectionKind` — the resolved camera projection discriminant.
 *
 * `view` and `proj` are returned separately so vertex picking can build its own
 * `viewProj = proj * view` for `worldToScreen` without recomputing the branch.
 */
export interface ScreenRay {
  readonly ray: ray.Ray;
  readonly view: mat4.Mat4;
  readonly proj: mat4.Mat4;
  readonly projectionKind: CameraProjection;
}

/**
 * Build the screen-to-world ray for `cameraEntity` at the viewport-relative
 * `(screenX, screenY)` coordinate: validate the camera component, read its world
 * transform, invert it to a view matrix, branch the projection on the camera
 * discriminant, and unproject the coordinate into a world-space ray.
 *
 * @returns The `ScreenRay`, or `undefined` when the camera entity carries no
 *   resolvable `Transform.world` (a degenerate miss — no view matrix can be built).
 * @throws {PickError} `code: 'camera-component-missing'` when `cameraEntity` has no `Camera`.
 */
export function computeScreenRay(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRay | undefined {
  // --- precondition: camera component present (structured error, charter P3) ---
  const camRes = world.get(cameraEntity, Camera);
  if (!camRes.ok) {
    throw new PickError(cameraEntity as unknown as number);
  }
  const cam = camRes.value;

  // --- camera world transform (feat-20260601 D-3: read Transform.world mat4) ---
  const camWorld = readWorldMatrix(world as WorldInternalView, cameraEntity);
  if (camWorld === undefined) {
    // A camera entity without a Transform cannot define a view matrix; treat the
    // degenerate case as a miss rather than fabricating an identity view (no spurious hit).
    return undefined;
  }

  // --- view = invert(camera world mat4) ---
  const view = mat4.create();
  mat4.invert(view, camWorld as unknown as mat4.Mat4Like);

  // --- projection: branch on the camera discriminant (research Finding 5a) ---
  const projectionKind = cameraProjectionFromF32(cam.projection);
  const proj = mat4.create();
  if (projectionKind === 'orthographic') {
    mat4.orthographic(proj, cam.left, cam.right, cam.bottom, cam.top, cam.near, cam.far);
  } else {
    mat4.perspective(proj, cam.fov, cam.aspect, cam.near, cam.far);
  }

  // --- screen -> world ray (two-point unproject; clamp + NaN/Inf sanitized inside) ---
  const r = ray.create();
  ray.screenToRay(r, screenX, screenY, viewportWidth, viewportHeight, view, proj, projectionKind);

  return { ray: r, view, proj, projectionKind };
}
