// pick-triangle.ts — precise screen ray / triangle query.
//
// This is the precise companion to pick()'s inexpensive world-AABB query. CPU
// triangle vertices are transformed into world space before testing the shared
// world ray. That keeps non-uniformly transformed instances and nearest-
// occluder ordering correct.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { computeScreenRay, readWorldMatrix } from './pick-core';

export interface TriangleHit {
  readonly entity: EntityHandle;
  /** Zero-based triangle index across supported triangle submeshes. */
  readonly triangleIndex: number;
  /** Exact world-space intersection point. */
  readonly point: Vec3Like;
  /** Distance from the screen ray origin in world units. */
  readonly distance: number;
  /** Barycentric weights for the triangle's first, second, and third vertices. */
  readonly barycentric: readonly [number, number, number];
  /** Present when the caller supplied the registry's payload identity resolver. */
  readonly assetGuid?: string;
  /** Zero-based explicit instance ordinal when the entity owns Instances. */
  readonly instanceIndex?: number;
  readonly precision: 'triangle';
}

export type TrianglePickUnavailableReason =
  | 'cpu-geometry-unavailable'
  | 'skinned-pose-unavailable'
  | 'instance-transforms-unavailable';

export type TrianglePickResult =
  | { readonly status: 'hit'; readonly hit: TriangleHit }
  | { readonly status: 'miss'; readonly precision: 'triangle' }
  | {
      readonly status: 'unavailable';
      readonly precision: 'unavailable';
      readonly reason: TrianglePickUnavailableReason;
      readonly entities: readonly EntityHandle[];
    };

export interface TrianglePickOptions {
  /** Resolve a loaded MeshAsset payload to its existing Catalog GUID. */
  readonly assetGuidOf?: (asset: MeshAsset) => string | undefined;
}

function narrowPosition(position: MeshAsset['attributes']['position']): Float32Array | undefined {
  if (position instanceof Float32Array) return position;
  if (position instanceof ArrayBuffer) return new Float32Array(position);
  return undefined;
}

function worldAabbHit(
  screenRay: ray.Ray,
  aabb: MeshAsset['aabb'],
  worldMatrix: mat4.Mat4Like,
): boolean {
  if (aabb === undefined || (aabb[0] as number) > (aabb[3] as number)) return true;
  const corners: readonly Vec3Like[] = [
    [aabb[0] as number, aabb[1] as number, aabb[2] as number],
    [aabb[3] as number, aabb[1] as number, aabb[2] as number],
    [aabb[0] as number, aabb[4] as number, aabb[2] as number],
    [aabb[3] as number, aabb[4] as number, aabb[2] as number],
    [aabb[0] as number, aabb[1] as number, aabb[5] as number],
    [aabb[3] as number, aabb[1] as number, aabb[5] as number],
    [aabb[0] as number, aabb[4] as number, aabb[5] as number],
    [aabb[3] as number, aabb[4] as number, aabb[5] as number],
  ];
  const world = vec3.create();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const corner of corners) {
    mat4.transformPoint(world, worldMatrix, corner);
    minX = Math.min(minX, world[0] as number);
    minY = Math.min(minY, world[1] as number);
    minZ = Math.min(minZ, world[2] as number);
    maxX = Math.max(maxX, world[0] as number);
    maxY = Math.max(maxY, world[1] as number);
    maxZ = Math.max(maxZ, world[2] as number);
  }
  return ray.rayAabbIntersects(screenRay, [minX, minY, minZ, maxX, maxY, maxZ]).hit;
}

function pointOnRay(screenRay: ray.Ray, point: Vec3Like): number {
  const dx = (point[0] as number) - (screenRay[0] as number);
  const dy = (point[1] as number) - (screenRay[1] as number);
  const dz = (point[2] as number) - (screenRay[2] as number);
  return (
    dx * (screenRay[3] as number) + dy * (screenRay[4] as number) + dz * (screenRay[5] as number)
  );
}

/**
 * Return the nearest exact triangle hit for a viewport ray.
 *
 * A result of `unavailable` is deliberate: a skinned mesh or a mesh without
 * CPU position data cannot make a truthful nearest-occluder claim. The query
 * only reports that state when such an entity's broad-phase AABB intersects
 * the ray, so unrelated unsupported meshes do not hide a valid hit.
 */
export function pickTriangle(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options: TrianglePickOptions = {},
): TrianglePickResult {
  const screen = computeScreenRay(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (screen === undefined) return { status: 'miss', precision: 'triangle' };

  const origin = screen.ray;
  const query = world
    .query({
      read: [Transform, GlobalTransform, MeshFilter, MeshRenderer],
      optional: [Instances],
    })
    .unwrap();
  let best: TriangleHit | undefined;
  let unsupportedReason: TrianglePickUnavailableReason | undefined;
  const unsupportedEntities: EntityHandle[] = [];

  for (const row of query) {
    const rawHandle = Math.round(row.get(MeshFilter).assetHandle as number);
    if (rawHandle === 0) continue;
    const resolved = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(rawHandle));
    if (!resolved.ok) continue;
    const mesh = resolved.value;
    const entity = row.entity;
    const entityWorldMatrix = readWorldMatrix(world, entity);
    if (entityWorldMatrix === undefined) continue;
    const instancesData = row.get(Instances);
    let instanceTransforms: Float32Array | undefined;
    let instanceCount = 1;
    if (instancesData !== undefined) {
      instanceTransforms = instancesData.transforms;
      if (instanceTransforms.length % 16 !== 0 || !instanceTransforms.every(Number.isFinite)) {
        unsupportedReason ??= 'instance-transforms-unavailable';
        unsupportedEntities.push(entity);
        continue;
      }
      instanceCount = instanceTransforms.length / 16;
    }

    const positions = narrowPosition(mesh.attributes.position);
    const skinned =
      mesh.attributes.skinIndex !== undefined && mesh.attributes.skinWeight !== undefined;
    if (skinned) {
      let intersects = false;
      for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
        const drawWorld =
          instanceTransforms === undefined
            ? (entityWorldMatrix as unknown as mat4.Mat4Like)
            : mat4.multiply(
                mat4.create(),
                entityWorldMatrix as unknown as mat4.Mat4Like,
                instanceTransforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
              );
        if (worldAabbHit(origin, mesh.aabb, drawWorld)) {
          intersects = true;
          break;
        }
      }
      if (!intersects) continue;
      unsupportedReason ??= 'skinned-pose-unavailable';
      unsupportedEntities.push(entity);
      continue;
    }
    if (positions === undefined || positions.length < 3) {
      let intersects = false;
      for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
        const drawWorld =
          instanceTransforms === undefined
            ? (entityWorldMatrix as unknown as mat4.Mat4Like)
            : mat4.multiply(
                mat4.create(),
                entityWorldMatrix as unknown as mat4.Mat4Like,
                instanceTransforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
              );
        if (worldAabbHit(origin, mesh.aabb, drawWorld)) {
          intersects = true;
          break;
        }
      }
      if (!intersects) continue;
      unsupportedReason ??= 'cpu-geometry-unavailable';
      unsupportedEntities.push(entity);
      continue;
    }

    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      const drawWorld =
        instanceTransforms === undefined
          ? (entityWorldMatrix as unknown as mat4.Mat4Like)
          : mat4.multiply(
              mat4.create(),
              entityWorldMatrix as unknown as mat4.Mat4Like,
              instanceTransforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
            );
      if (!worldAabbHit(origin, mesh.aabb, drawWorld)) continue;

      const worldA = vec3.create();
      const worldB = vec3.create();
      const worldC = vec3.create();
      const worldPoint = vec3.create();
      let triangleIndex = 0;
      const indices = mesh.indices;
      const maxVertex = Math.floor(positions.length / 3) - 1;
      const test = (i0: number, i1: number, i2: number, index: number): void => {
        if (i0 < 0 || i1 < 0 || i2 < 0 || i0 > maxVertex || i1 > maxVertex || i2 > maxVertex)
          return;
        const a = [
          positions[i0 * 3] as number,
          positions[i0 * 3 + 1] as number,
          positions[i0 * 3 + 2] as number,
        ] as Vec3Like;
        const b = [
          positions[i1 * 3] as number,
          positions[i1 * 3 + 1] as number,
          positions[i1 * 3 + 2] as number,
        ] as Vec3Like;
        const c = [
          positions[i2 * 3] as number,
          positions[i2 * 3 + 1] as number,
          positions[i2 * 3 + 2] as number,
        ] as Vec3Like;
        mat4.transformPoint(worldA, drawWorld, a);
        mat4.transformPoint(worldB, drawWorld, b);
        mat4.transformPoint(worldC, drawWorld, c);
        const hit = ray.rayTriangleIntersects(origin, worldA, worldB, worldC);
        if (!hit.hit) return;
        // The local ray origin is stored in the first three slots; construct the
        // point explicitly to avoid relying on a mutable Ray alias.
        worldPoint[0] = (origin[0] as number) + (origin[3] as number) * hit.t;
        worldPoint[1] = (origin[1] as number) + (origin[4] as number) * hit.t;
        worldPoint[2] = (origin[2] as number) + (origin[5] as number) * hit.t;
        const distance = pointOnRay(origin, worldPoint);
        if (
          !Number.isFinite(distance) ||
          distance < 0 ||
          (best !== undefined && distance >= best.distance)
        )
          return;
        const assetGuid = options.assetGuidOf?.(mesh);
        best = {
          entity,
          triangleIndex: index,
          point: [worldPoint[0], worldPoint[1], worldPoint[2]] as unknown as Vec3Like,
          distance,
          barycentric: [1 - hit.u - hit.v, hit.u, hit.v],
          ...(assetGuid === undefined ? {} : { assetGuid }),
          ...(instanceTransforms === undefined ? {} : { instanceIndex }),
          precision: 'triangle',
        };
      };

      for (const submesh of mesh.submeshes) {
        if (submesh.topology !== 'triangle-list' && submesh.topology !== 'triangle-strip') continue;
        const strip = submesh.topology === 'triangle-strip';
        if (indices !== undefined && indices.length > 0 && submesh.indexCount > 0) {
          const count = strip
            ? Math.max(0, submesh.indexCount - 2)
            : Math.floor(submesh.indexCount / 3);
          for (let localTriangle = 0; localTriangle < count; localTriangle += 1) {
            if (strip) {
              const base = submesh.indexOffset + localTriangle;
              const i0 = indices[base] as number;
              const i1 = indices[base + 1] as number;
              const i2 = indices[base + 2] as number;
              // WebGPU alternates strip winding after every vertex. The
              // intersection is double-sided, but preserving the primitive's
              // authored order keeps barycentrics and triangle identity honest.
              if ((localTriangle & 1) === 0) test(i0, i1, i2, triangleIndex);
              else test(i2, i1, i0, triangleIndex);
            } else {
              const base = submesh.indexOffset + localTriangle * 3;
              test(
                indices[base] as number,
                indices[base + 1] as number,
                indices[base + 2] as number,
                triangleIndex,
              );
            }
            triangleIndex += 1;
          }
        } else {
          const count = strip
            ? Math.max(0, submesh.vertexCount - 2)
            : Math.floor(submesh.vertexCount / 3);
          for (let localTriangle = 0; localTriangle < count; localTriangle += 1) {
            if (strip) {
              const i0 = localTriangle;
              const i1 = localTriangle + 1;
              const i2 = localTriangle + 2;
              if ((localTriangle & 1) === 0) test(i0, i1, i2, triangleIndex);
              else test(i2, i1, i0, triangleIndex);
            } else {
              const base = localTriangle * 3;
              test(base, base + 1, base + 2, triangleIndex);
            }
            triangleIndex += 1;
          }
        }
      }
    }
  }

  if (unsupportedReason !== undefined) {
    return {
      status: 'unavailable',
      precision: 'unavailable',
      reason: unsupportedReason,
      entities: unsupportedEntities,
    };
  }
  return best === undefined
    ? { status: 'miss', precision: 'triangle' }
    : { status: 'hit', hit: best };
}
