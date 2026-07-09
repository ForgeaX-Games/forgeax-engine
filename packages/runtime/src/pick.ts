// pick.ts — screen-to-entity raycast (feat-20260529-picking-raycasting-screen-to-entity M3 / w13).
//
// `pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`
// is a free function (NOT `world.pick()`; requirements hard constraint): it unprojects
// a viewport-relative screen coordinate into a world-space ray through the supplied
// camera, walks every renderable archetype, ray-AABB tests each pickable mesh's
// world-space bounding box, and returns the NEAREST `PickHit` (or `undefined` on miss).
//
// Mesh AABB source (feat-20260614 M8, D-15/D-18): the ray-AABB test needs each
// mesh's local-space `MeshAsset.aabb`, resolved from the entity's `MeshFilter`
// handle via `resolveAssetHandle<MeshAsset>(world, handle)` (two-tier builtin /
// world.sharedRefs dispatch). The registry no longer holds handles, so `pick`
// takes no `AssetRegistry` -- it resolves entirely World-side. Keeping `pick` a
// free function (rather than a `World` method) preserves the layering: `World`
// (engine-ecs) stays asset-free; the picking glue lives in the runtime package
// alongside the renderer.
//
// Error channel split (charter P3): the single unrecoverable precondition —
// `cameraEntity` carries no `Camera` — throws a structured `PickError`
// (`code: 'camera-component-missing'`); the ordinary "ray hit nothing" outcome returns
// `undefined`. AI users branch with `if (hit)` for the common case and only handle
// `PickError` where they cannot guarantee the camera entity is well-formed.
//
// Transform source (feat-20260601 D-3): per entity (camera + candidates) read the
// single resolved `Transform.world` mat4 written by `propagateTransforms` -- the
// GlobalTransform/Transform fallback double-track is retired (the world column
// always exists on a Transform-bearing entity). The camera view is
// `mat4.invert(Transform.world)`; the candidate AABB is the local AABB
// transformed by `Transform.world` directly. The world mat4 is read through the
// M1 column-level array view (`_getArrayView`), zero `{}` materialization.
//
// Related: requirements in-scope #5/#6/#7 + AC-05..AC-11; plan-strategy D-3 / D-6 / 5.3;
//          research Finding 4 (local->world AABB) + Finding 5 (entity-id via _getGraph).

import type { Component, EntityHandle, FieldView, World } from '@forgeax/engine-ecs';
import { Entity } from '@forgeax/engine-ecs';
import { box3, mat4, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { Camera, MeshFilter, MeshRenderer, Transform } from './components';
import { cameraProjectionFromF32 } from './components/camera';
import { PickError } from './pick-errors';
import { resolveAssetHandle } from './resolve-asset-handle';

/**
 * Result of a successful screen-to-entity pick.
 *
 * Minimal three-field surface (D-6):
 *   - `entity`   — the picked `Entity` (packed u32 handle, ready for `world.get` / `world.set`)
 *   - `point`    — the world-space ray/AABB entry point (`Vec3Like`; a 3-element array)
 *   - `distance` — the entry distance along the ray from the camera (>= 0)
 *
 * No `face` / `uv` / `normal` fields: AABB picking has no triangle resolution, so those
 * would be a lie. A future mesh-precise pick spin-off owns them (requirements OOS).
 */
export interface PickHit {
  readonly entity: EntityHandle;
  readonly point: Vec3Like;
  readonly distance: number;
}

/** Internal world surface used by pick for the resolved `Transform.world` view. */
type WorldInternalView = World & {
  /**
   * @internal Column-level zero-copy view of an `array<T, N>` / `buffer<N>` field.
   * Returns a `FieldView` (a TypedArray) aliasing the inline stride-N column bytes;
   * pick reads the resolved `Transform.world` mat4 through it (a `Float32Array` in
   * practice, feat-20260602 inline columns). The return type is the generic
   * `FieldView` because the underlying column may store any element type;
   * `new Float32Array(view)` below reinterprets the world mat4 from whichever
   * TypedArray backs it. `undefined` when the entity is dead or the column absent.
   */
  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined;
};

/**
 * Read an entity's resolved world mat4 (16 column-major floats) from the
 * `Transform.world` column array view (feat-20260601 D-3). Returns a fresh
 * copy (the view aliases live slot bytes); `undefined` when the entity has no
 * Transform / world column.
 */
function readWorldMatrix(world: WorldInternalView, entity: EntityHandle): Float32Array | undefined {
  const view = world._getArrayView(entity, Transform, 'world');
  if (view === undefined) return undefined;
  return new Float32Array(view);
}

/**
 * Raycast from a viewport-relative screen coordinate into the world and return the
 * nearest pickable mesh entity whose world-space AABB the ray enters.
 *
 * @param world The ECS world holding the camera + candidate mesh entities (and the
 *   per-World SharedRefStore that owns each `MeshAsset` and its local-space `aabb`).
 * @param cameraEntity The entity carrying the `Camera` component (and a Transform).
 * @param screenX Horizontal pixel coordinate relative to the viewport top-left (y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @returns The nearest `PickHit`, or `undefined` when the ray hits nothing.
 * @throws {PickError} `code: 'camera-component-missing'` when `cameraEntity` has no `Camera`.
 */
export function pick(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): PickHit | undefined {
  // --- precondition: camera component present (structured error, charter P3) ---
  const camRes = world.get(cameraEntity, Camera);
  if (!camRes.ok) {
    throw new PickError(cameraEntity as unknown as number);
  }
  const cam = camRes.value;

  const worldInternal = world as WorldInternalView;

  // --- camera world transform (feat-20260601 D-3: read Transform.world mat4) ---
  const camWorld = readWorldMatrix(worldInternal, cameraEntity);
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

  // --- walk renderable archetypes (Transform + MeshFilter + MeshRenderer) ---
  // The ids are the global token.id; archetypes lacking the column are skipped
  // by the `componentIds.includes` guards below, so unregistered components
  // naturally yield an empty walk (D-2).

  const graph = (
    worldInternal as unknown as { _getGraph(): { archetypes: ArchetypeLike[] } }
  )._getGraph();

  const worldAabb = box3.create();
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEntity: EntityHandle | undefined;

  for (const arch of graph.archetypes) {
    if (!arch || arch.size === 0) continue;
    if (!arch.components.some((c) => c.id === MeshRenderer.id)) continue;
    if (!arch.components.some((c) => c.id === MeshFilter.id)) continue;
    if (!arch.components.some((c) => c.id === Transform.id)) continue;

    const mfCols = arch.columns.get(MeshFilter.id);
    if (!mfCols) continue;
    const assetHandleView = mfCols.get('assetHandle')?.view as Uint32Array | undefined;
    if (!assetHandleView) continue;

    for (let i = 0; i < arch.size; i++) {
      const assetHandleRaw = Math.round(assetHandleView[i] ?? 0);
      if (assetHandleRaw === 0) continue;
      const meshRes = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(assetHandleRaw));
      if (!meshRes.ok) continue;
      const localAabb = meshRes.value.aabb;
      if (localAabb === undefined) continue;
      // Inverted-infinity empty box (mesh without positions): not pickable.
      if ((localAabb[0] as number) > (localAabb[3] as number)) continue;

      // read the packed Entity for this row from the essential id=0 Entity
      // column (`self` field); the column exists on every archetype.
      const entitySelfView = arch.columns.get(Entity.id)?.get('self')?.view as
        | Uint32Array
        | undefined;
      const entity = (entitySelfView?.[i] ?? 0) as EntityHandle;

      // local AABB -> world AABB using the resolved Transform.world mat4
      // directly (feat-20260601 D-3: no compose from decomposed TRS).
      const entityWorld = readWorldMatrix(worldInternal, entity);
      if (entityWorld === undefined) continue;
      box3.transformBox3(
        worldAabb,
        localAabb,
        entityWorld as unknown as Parameters<typeof box3.transformBox3>[2],
      );

      const result = ray.rayAabbIntersects(r, worldAabb);
      if (result.hit && result.tmin < bestDistance) {
        bestDistance = result.tmin;
        bestEntity = entity;
      }
    }
  }

  if (bestEntity === undefined) return undefined;

  // entry point = origin + direction * tmin
  const origin = vec3.create();
  const dir = vec3.create();
  ray.getOrigin(origin, r);
  ray.getDirection(dir, r);
  const point = vec3.create(
    (origin[0] as number) + (dir[0] as number) * bestDistance,
    (origin[1] as number) + (dir[1] as number) * bestDistance,
    (origin[2] as number) + (dir[2] as number) * bestDistance,
  );

  return { entity: bestEntity, point, distance: bestDistance };
}

/** Minimal shape of an archetype as exposed by the engine-internal `_getGraph()`. */
interface ArchetypeLike {
  size: number;
  components: ReadonlyArray<{ readonly id: number }>;
  columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
}
