// @forgeax/engine-physics-rapier2d — vector bridge between forgeax math types
// and Rapier's plain {x,y} POD objects (plan-strategy D-6, 2D adaptation).
//
// Conversions live in the backend package (not the interface package) so
// engine-math types don't leak into the Rapier-specific layer.

import { type Vec2, vec2 } from '@forgeax/engine-math';

/** Convert a forgeax Vec2 (Float32Array) to a Rapier 2D vector {x,y}. */
export function toRapierVec2(v: Vec2): { x: number; y: number } {
  return { x: v[0] ?? 0, y: v[1] ?? 0 };
}

/** Convert a Rapier 2D vector {x,y} to a forgeax Vec2 (Float32Array). */
export function fromRapierVec2(v: { x: number; y: number }): Vec2 {
  return vec2.create(v.x, v.y);
}
