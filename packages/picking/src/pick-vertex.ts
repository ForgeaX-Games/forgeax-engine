// pick-vertex.ts — per-entity + full-scene vertex-level picking (feat-20260630-vertex-snapping-picking).
//
// `pickVertexOnEntity(world, cameraEntity, screenX, screenY, vpW, vpH, entity, options?)`
// returns the vertex(es) on a single entity nearest to the supplied screen coordinate.
//
// `pickVertex(world, cameraEntity, screenX, screenY, vpW, vpH, options?)`
// walks all renderable archetypes (AABB coarse cull), calls pickVertexOnEntity on each
// ray-intersecting entity, and returns the globally-nearest vertex hits sorted by screenDist.
//
// M2 scope (w5): single-entity query with overloaded three-state return (D-2).
// M3 scope (w8): degradation branches (D-4/D-5/AC-07/R-3) + pickVertex full-scene (R-2).
//
// Overload contract:
//   - No options / no limit → VertexHit | undefined
//   - { limit: N }       → VertexHit[]
//
// Reuses pick()'s full skeleton (camera validation / view=invert(world) / projection branch /
// screenToRay / resolveAssetHandle / Transform.world / AABB coarse cull), then for each
// triangle-list submesh that passes the AABB test, iterates every triangle and collects
// vertex candidates via rayTriangleIntersects.
//
// Key design points:
//   - D-7: worldPos uses Vec3Like (not branded Vec3), mirroring PickHit.point.
//   - D-8: reuses PickError with ZERO new error codes — the sole throw remains
//     camera-component-missing; all other miss conditions return undefined / [].
//   - D-9: caller MUST propagateTransforms(world) before calling — the function reads
//     Transform.world directly.
//   - AC-08: deformed = isSkinned (attributes.skinIndex && attributes.skinWeight both
//     defined, SSOT at asset-registry.ts:1417-1418).
//   - R-3: behind-camera vertices (worldToScreen returns behind=true) are excluded.
//   - D-4: position three-branch narrow (Float32Array → use; ArrayBuffer → new Float32Array;
//     Uint16Array / undefined → skip mesh), mirrors computeAABB asset-registry.ts:1898-1929.
//   - D-5: only triangle-list topology participates; triangle-strip / line-list /
//     line-strip / point-list → skip submesh.
//   - AC-07: builtin mesh with aabb===undefined → fallback to walk-all-vertices
//     (not continue like pick.ts:184).
//
// Related: requirements AC-01/AC-02/AC-03/AC-04/AC-05/AC-07/AC-08/AC-09/AC-10/AC-13;
//          plan-strategy D-2/D-3/D-4/D-5/D-7/D-8/D-9 §4 R-2/R-3;
//          research Finding 1 (reuse pick skeleton) / Finding 2 (PickError) /
//          Finding 4 (computeAABB three-branch) / Finding 5 (builtin withoutAabb) /
//          Finding 6 (non-indexed sequence) / Finding 8 (Transform.world) /
//          Finding 9 (behind flag) / Finding 10 (isSkinned);
//          plan-tasks.json w5/w8 acceptanceCheck.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec2, vec3 } from '@forgeax/engine-math';
import { MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import {
  type ArchetypeLike,
  computeScreenRay,
  readWorldMatrix,
  type WorldInternalView,
} from './pick-core';

// ── types ────────────────────────────────────────────────────────────────

/**
 * Result of a successful vertex pick: the mesh vertex nearest to the
 * supplied screen-space coordinate.
 *
 * Field set:
 *   - `entity`      — the entity this vertex belongs to.
 *   - `vertexIndex` — index into the vertex position buffer (0-based).
 *   - `worldPos`    — world-space position of the vertex (Vec3Like; rest-pose when
 *                     deformed=true). D-7: Vec3Like avoids math brand cast lint in
 *                     the runtime package.
 *   - `screenDist`  — screen-space pixel distance from the query coordinate to the
 *                     projected vertex position (non-negative).
 *   - `worldDist`   — perpendicular 3D distance from the vertex world position to
 *                     the pick ray (non-negative). Orthogonal counterpart to screenDist.
 *   - `deformed`    — true when the mesh is skinned (skinIndex + skinWeight attributes
 *                     both present), indicating worldPos reflects rest-pose, not GPU
 *                     skinning output.
 */
export interface VertexHit {
  readonly entity: EntityHandle;
  readonly vertexIndex: number;
  readonly worldPos: Vec3Like;
  readonly screenDist: number;
  readonly worldDist: number;
  readonly deformed: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Scratch Vec2 for worldToScreen calls (reused across invocations). */
const _scratchVec2 = vec2.create();

/**
 * Compute the perpendicular distance from a point to a ray in 3D.
 * rayDir is assumed normalized; returns |(P - O) x D|.
 */
function pointToRayDist(
  px: number,
  py: number,
  pz: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ex = px - ox;
  const ey = py - oy;
  const ez = pz - oz;
  const cx = ey * dz - ez * dy;
  const cy = ez * dx - ex * dz;
  const cz = ex * dy - ey * dx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Test whether a ray intersects a local-space AABB transformed by a world matrix.
 * Returns false when the ray misses the box; returns true when the box is
 * inverted (empty) — caller falls through to walk-all-vertices (AC-07).
 *
 * Extracted from collectVertexHits and pickVertex (review I-3, ~48 lines x2).
 */
function rayHitsWorldAabb(
  r: Float32Array,
  localAabb: Float32Array,
  worldMat: mat4.Mat4Like,
): boolean {
  // skip inverted-infinity empty box — fall through to walk-all-vertices
  if ((localAabb[0] as number) > (localAabb[3] as number)) return true;

  const corners = [
    [localAabb[0] as number, localAabb[1] as number, localAabb[2] as number],
    [localAabb[3] as number, localAabb[1] as number, localAabb[2] as number],
    [localAabb[0] as number, localAabb[4] as number, localAabb[2] as number],
    [localAabb[3] as number, localAabb[4] as number, localAabb[2] as number],
    [localAabb[0] as number, localAabb[1] as number, localAabb[5] as number],
    [localAabb[3] as number, localAabb[1] as number, localAabb[5] as number],
    [localAabb[0] as number, localAabb[4] as number, localAabb[5] as number],
    [localAabb[3] as number, localAabb[4] as number, localAabb[5] as number],
  ];
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const tmpP = vec3.create();
  for (const c of corners) {
    mat4.transformPoint(tmpP, worldMat, c as unknown as Vec3Like);
    const cx = tmpP[0] as number;
    const cy = tmpP[1] as number;
    const cz = tmpP[2] as number;
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cz < minZ) minZ = cz;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
    if (cz > maxZ) maxZ = cz;
  }
  const worldAabb = new Float32Array(6);
  worldAabb[0] = minX;
  worldAabb[1] = minY;
  worldAabb[2] = minZ;
  worldAabb[3] = maxX;
  worldAabb[4] = maxY;
  worldAabb[5] = maxZ;

  const aabbResult = ray.rayAabbIntersects(
    r,
    worldAabb as unknown as import('@forgeax/engine-math').box3.Box3Like,
  );
  return aabbResult.hit;
}

/**
 * Narrow the position attribute per the three-branch contract (D-4),
 * mirrors computeAABB asset-registry.ts:1898-1908.
 * Returns the Float32Array position data, or undefined when the position
 * is Uint16Array / undefined / too short (skip this mesh).
 */
function narrowPosition(
  positionAttr: ArrayBuffer | Float32Array | Uint16Array | undefined,
): Float32Array | undefined {
  if (positionAttr instanceof Float32Array) {
    return positionAttr;
  }
  if (positionAttr instanceof ArrayBuffer) {
    return new Float32Array(positionAttr);
  }
  // Uint16Array or undefined → skip (no usable float-coordinate vertex data)
  return undefined;
}

// ── internal: per-entity vertex hit collection (extracted for pickVertex reuse) ──

/**
 * Core per-entity vertex hit collection.
 * Returns all vertex candidates for one entity, unsorted.
 * Caller sorts and applies limit.
 */
function collectVertexHits(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
): VertexHit[] {
  // ── camera validation + view/projection + screen->world ray (pick-core skeleton) ──
  // Throws PickError('camera-component-missing') when cameraEntity has no Camera;
  // returns undefined when the camera has no resolvable Transform.world (D-9 preamble miss).
  const screenRay = computeScreenRay(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (screenRay === undefined) {
    return [];
  }
  const { ray: r, view, proj } = screenRay;

  // ── viewProj = proj * view (precompute for worldToScreen calls) ──
  const viewProj = mat4.create();
  mat4.multiply(viewProj, proj as unknown as mat4.Mat4Like, view as unknown as mat4.Mat4Like);

  const rOx = r[0] as number;
  const rOy = r[1] as number;
  const rOz = r[2] as number;
  const rDx = r[3] as number;
  const rDy = r[4] as number;
  const rDz = r[5] as number;

  // ── resolve entity's mesh asset ──
  const mfRes = world.get(entity, MeshFilter);
  if (!mfRes.ok) {
    return [];
  }
  const meshRes = resolveAssetHandle<MeshAsset>(
    world,
    toShared<'MeshAsset'>(mfRes.value.assetHandle as unknown as number),
  );
  if (!meshRes.ok) {
    return [];
  }
  const mesh = meshRes.value;

  // ── position attribute narrow (D-4: three-branch, mirrors computeAABB) ──
  const positions = narrowPosition(mesh.attributes.position);
  if (positions === undefined || positions.length < 3) {
    return [];
  }

  // ── entity world transform (D-9: requires propagateTransforms preamble) ──
  const entityWorld = readWorldMatrix(world as WorldInternalView, entity);
  if (entityWorld === undefined) {
    return [];
  }

  // ── deformed flag (AC-08: isSkinned, SSOT at asset-registry.ts:1417-1418) ──
  const attrs = mesh.attributes;
  const deformed: boolean =
    attrs !== undefined && attrs.skinIndex !== undefined && attrs.skinWeight !== undefined;

  // ── AABB coarse cull (if aabb present) ──
  // AC-07: if aabb is undefined, DO NOT continue — fallthrough to walk-all-vertices.
  // This is the key behavioral difference from pick.ts:184.
  const entityWMLike = entityWorld as unknown as mat4.Mat4Like;

  if (mesh.aabb !== undefined && !rayHitsWorldAabb(r, mesh.aabb, entityWMLike)) {
    return [];
  }
  // AC-07: aabb===undefined → fall through to walk-all-vertices (builtin no-AABB fallback).

  // ── iterate submeshes + triangles ──
  const candidates: VertexHit[] = [];
  const seen = new Set<number>(); // (entity, vertexIndex) dedup (review I-1)
  const indices = mesh.indices;
  const submeshes = mesh.submeshes;
  const maxVertexIndex = Math.floor(positions.length / 3) - 1;

  // Shared vertex-emit closure: given 3 vertex indices for a hit triangle,
  // compute worldPos + screenDist + worldDist and push candidates.
  // Extracted from the duplicated ~45-line indexed/non-indexed body (review I-2).
  const emitTriangleVertices = (i0: number, i1: number, i2: number): void => {
    const ax = positions[i0 * 3 + 0] as number;
    const ay = positions[i0 * 3 + 1] as number;
    const az = positions[i0 * 3 + 2] as number;
    const bx = positions[i1 * 3 + 0] as number;
    const by = positions[i1 * 3 + 1] as number;
    const bz = positions[i1 * 3 + 2] as number;
    const cx = positions[i2 * 3 + 0] as number;
    const cy = positions[i2 * 3 + 1] as number;
    const cz = positions[i2 * 3 + 2] as number;

    const triResult = ray.rayTriangleIntersects(
      r,
      [ax, ay, az] as unknown as Vec3Like,
      [bx, by, bz] as unknown as Vec3Like,
      [cx, cy, cz] as unknown as Vec3Like,
    );

    if (!triResult.hit) return;

    for (const [vi, lx, ly, lz] of [
      [i0, ax, ay, az],
      [i1, bx, by, bz],
      [i2, cx, cy, cz],
    ] as [number, number, number, number][]) {
      if (Number.isNaN(lx) || Number.isNaN(ly) || Number.isNaN(lz)) continue;
      if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;

      const worldVec = vec3.create();
      mat4.transformPoint(worldVec, entityWMLike, [lx, ly, lz] as unknown as Vec3Like);
      const wx = worldVec[0] as number;
      const wy = worldVec[1] as number;
      const wz = worldVec[2] as number;

      const screenRes = ray.worldToScreen(
        _scratchVec2,
        [wx, wy, wz] as unknown as Vec3Like,
        viewProj as unknown as import('@forgeax/engine-math').Mat4Like,
        viewportWidth,
        viewportHeight,
      );

      if (screenRes.behind) continue;

      // Dedup: same vertex hit by multiple triangles — keep only first
      // (same vertexIndex = same world-space position, screenDist/worldDist identical).
      if (seen.has(vi)) continue;
      seen.add(vi);

      const sx = _scratchVec2[0] as number;
      const sy = _scratchVec2[1] as number;
      const sdx = sx - screenX;
      const sdy = sy - screenY;
      const screenDist = Math.sqrt(sdx * sdx + sdy * sdy);
      const worldDist = pointToRayDist(wx, wy, wz, rOx, rOy, rOz, rDx, rDy, rDz);

      candidates.push({
        entity,
        vertexIndex: vi,
        worldPos: [wx, wy, wz] as unknown as Vec3Like,
        screenDist,
        worldDist,
        deformed,
      });
    }
  };

  for (const submesh of submeshes) {
    // D-5: only triangle-list participates
    if (submesh.topology !== 'triangle-list') continue;

    const idxOffset = submesh.indexOffset;
    const idxCount = submesh.indexCount;

    if (indices !== undefined && indices.length > 0 && idxCount > 0) {
      // indexed draw
      const triCount = Math.floor(idxCount / 3);
      for (let ti = 0; ti < triCount; ti++) {
        const i0 = indices[idxOffset + ti * 3 + 0] as number;
        const i1 = indices[idxOffset + ti * 3 + 1] as number;
        const i2 = indices[idxOffset + ti * 3 + 2] as number;

        if (i0 > maxVertexIndex || i1 > maxVertexIndex || i2 > maxVertexIndex) continue;
        emitTriangleVertices(i0, i1, i2);
      }
    } else {
      // AC-09: no index buffer → non-indexed triangle sequence
      const submeshVertexCount = submesh.vertexCount;
      const triCount = Math.floor(submeshVertexCount / 3);

      for (let ti = 0; ti < triCount; ti++) {
        const i0 = ti * 3;
        const i1 = ti * 3 + 1;
        const i2 = ti * 3 + 2;

        if (i0 > maxVertexIndex || i1 > maxVertexIndex || i2 > maxVertexIndex) continue;
        emitTriangleVertices(i0, i1, i2);
      }
    }
  }

  return candidates;
}

// ── overload signatures: pickVertexOnEntity (D-2: three-state static dispatch) ──

/**
 * Query the nearest vertex on a single entity.
 *
 * Without options: returns `VertexHit | undefined` (nearest hit, or `undefined` on miss).
 *
 * @param world The ECS world (propagateTransforms must have been called this frame).
 * @param cameraEntity Entity carrying the Camera component (and Transform).
 * @param screenX Horizontal pixel coordinate (viewport top-left, y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @param entity The mesh entity to query (must carry MeshFilter + MeshRenderer).
 * @returns The nearest `VertexHit`, or `undefined` when nothing is hit.
 * @throws {PickError} `code: 'camera-component-missing'` when cameraEntity has no Camera.
 */
export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
): VertexHit | undefined;

/**
 * Query up to `limit` nearest vertices on a single entity.
 *
 * With `{ limit }`: returns `VertexHit[]` sorted by `screenDist` ascending.
 *
 * @param options.limit Maximum number of candidates to return (returns all available
 *   vertices when limit exceeds the hit count).
 * @returns Sorted array of `VertexHit` (empty on miss).
 */
export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options: { limit: number },
): VertexHit[];

export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  const candidates = collectVertexHits(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
    entity,
  );

  // ── sort by screenDist ascending ──
  candidates.sort((a, b) => a.screenDist - b.screenDist);

  // ── apply limit / return shape ──
  const limit = options?.limit;
  if (limit !== undefined) {
    return candidates.slice(0, limit);
  }
  return candidates[0];
}

// ── overload signatures: pickVertex (full-scene, D-2: three-state static dispatch) ──

/**
 * Query the nearest vertex across all pickable mesh entities in the world.
 *
 * Without options: returns `VertexHit | undefined` (globally nearest, or `undefined` on miss).
 *
 * Walks all renderable archetypes, does an AABB coarse cull (R-2), then calls
 * `pickVertexOnEntity` on each ray-intersecting entity. Builtin meshes without AABB
 * fall through to walk-all-vertices (AC-07).
 *
 * @param world The ECS world (propagateTransforms must have been called this frame).
 * @param cameraEntity Entity carrying the Camera component (and Transform).
 * @param screenX Horizontal pixel coordinate (viewport top-left, y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @returns The globally nearest `VertexHit`, or `undefined` when nothing is hit.
 * @throws {PickError} `code: 'camera-component-missing'` when cameraEntity has no Camera.
 */
export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): VertexHit | undefined;

/**
 * Query up to `limit` nearest vertices across all pickable mesh entities.
 *
 * With `{ limit }`: returns `VertexHit[]` globally sorted by `screenDist` ascending.
 *
 * @param options.limit Maximum number of candidates to return.
 * @returns Sorted array of `VertexHit` (empty on miss).
 */
export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options: { limit: number },
): VertexHit[];

export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  // ── camera validation + view/projection + screen->world ray (pick-core skeleton) ──
  // Throws PickError('camera-component-missing') when cameraEntity has no Camera;
  // returns undefined when the camera has no resolvable Transform.world (degenerate miss).
  const screenRay = computeScreenRay(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (screenRay === undefined) {
    if (options) return [];
    return undefined;
  }
  const r = screenRay.ray;

  // ── walk renderable archetypes (Transform + MeshFilter + MeshRenderer) ──
  // Reuse pick.ts archetype walk skeleton (research Finding 1).
  const worldInternal = world as unknown as {
    _getGraph(): { archetypes: ArchetypeLike[] };
  };
  const graph = worldInternal._getGraph();

  const allCandidates: VertexHit[] = [];

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

      // read entity (mirrors pick.ts:190)
      const entitySelfView = arch.columns.get(Entity.id)?.get('self')?.view as
        | Uint32Array
        | undefined;
      const entity = (entitySelfView?.[i] ?? 0) as EntityHandle;

      // read entity world matrix
      const entityWorld = readWorldMatrix(world as WorldInternalView, entity);
      if (entityWorld === undefined) continue;

      // AABB coarse cull (R-2): if aabb present, test ray intersection.
      // If aabb===undefined (builtin), fall through to collectVertexHits (AC-07).
      const mesh = meshRes.value;
      if (
        mesh.aabb !== undefined &&
        !rayHitsWorldAabb(r, mesh.aabb, entityWorld as unknown as mat4.Mat4Like)
      ) {
        continue;
      }

      // Collect vertices for this entity
      const entityHits = collectVertexHits(
        world,
        cameraEntity,
        screenX,
        screenY,
        viewportWidth,
        viewportHeight,
        entity,
      );
      for (const h of entityHits) {
        allCandidates.push(h);
      }
    }
  }

  // ── global sort by screenDist ascending ──
  allCandidates.sort((a, b) => a.screenDist - b.screenDist);

  // ── apply limit / return shape ──
  const limit = options?.limit;
  if (limit !== undefined) {
    return allCandidates.slice(0, limit);
  }
  return allCandidates[0];
}
