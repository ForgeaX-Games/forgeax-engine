// @forgeax/engine-physics-rapier3d — vector bridge between forgeax math types
// and Rapier's plain {x,y,z} POD objects (plan-strategy D-6).
//
// forgeax Vec3 is a branded Float32Array accessed via v[0], v[1], v[2].
// Rapier uses plain JS objects like { x: number; y: number; z: number }.
//
// Conversions live in the backend package (not the interface package) so
// engine-math types don't leak into the Rapier-specific layer.

import { type Quat, quat, type Vec3, vec3 } from '@forgeax/engine-math';

/** Convert a forgeax Vec3 (Float32Array) to a Rapier 3D vector {x,y,z}. */
export function toRapierVec3(v: Vec3): { x: number; y: number; z: number } {
  return { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 };
}

/** Convert a Rapier 3D vector {x,y,z} to a forgeax Vec3 (Float32Array). */
export function fromRapierVec3(v: { x: number; y: number; z: number }): Vec3 {
  return vec3.create(v.x, v.y, v.z);
}

/** Convert a forgeax Quat to a Rapier 3D quaternion {w,x,y,z}. */
export function toRapierQuat(q: Quat): { w: number; x: number; y: number; z: number } {
  return { w: q[3] ?? 1, x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0 };
}

/** Convert a Rapier 3D quaternion {w,x,y,z} to a forgeax Quat. */
export function fromRapierQuat(q: { w: number; x: number; y: number; z: number }): Quat {
  return quat.clone([q.x, q.y, q.z, q.w]);
}
