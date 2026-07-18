// @forgeax/engine-runtime - host-side light helpers (M2 / w12).
//
// Pure-function single-shot conversion helpers for the SpotLight + PointLight
// extract path. Host calls each helper once per light entity per frame; the
// shader then sees only pre-computed `cos*` / `invRangeSquared` values
// (plan-strategy D-S2 byte freeze + charter P4 host pre-multiplication
// parity; KHR_lights_punctual industrial convention per research Finding 1).
//
// AC anchors: requirements AC-03 (deg -> rad -> cos host two-step
// conversion) + AC-08 (a + b) (KHR quartic + range = 0 NaN protection
// boundary).
//
// Plan-strategy anchors: D-S2 (cone unit deg API + cos shader optimization
// transparent to AI users) + D-S5 (Layer 1 host-side range = 0 ->
// invRangeSquared = 1e8 protects the 0 * Infinity = NaN intermediate).

import { SpawnLightInvalidBoundsError } from '@forgeax/engine-ecs';

const RANGE_ZERO_FALLBACK_INV_R2 = 1e8;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Convert SpotLight cone half-angle (degrees) to its cosine.
 *
 * Single-shot deg -> rad -> cos conversion executed once per spot light
 * entity per frame on the host; the GPU shader sees only `cosInner` /
 * `cosOuter` so its falloff path stays branch-free
 * (`smoothstep(cosOuter, cosInner, dot(L, -lightDir))`).
 *
 * @param deg cone half-angle in degrees (component schema field
 *            `innerConeDeg` / `outerConeDeg`)
 * @returns `cos(deg * pi / 180)`
 */
export function degToCos(deg: number): number {
  return Math.cos(deg * DEG_TO_RAD);
}

/**
 * Convert PointLight / SpotLight `range` (meters) to `1 / range^2`.
 *
 * Three-branch fold mirrors the KHR_lights_punctual quartic falloff term
 * `max(min(1 - (d^2 * invR^2)^2, 1), 0) / max(d^2, 1e-4)`:
 *
 *   - `range = +Infinity` -> `0` (no truncation; quartic factor collapses
 *     to `1`, falloff reduces to plain `1 / d^2`).
 *   - `range = 0` -> `1e8` (NaN protection; the literal `0 * Infinity` would
 *     produce `NaN` and silently corrupt the entire pixel; plan-strategy
 *     D-S5 Layer 1 host fallback).
 *   - `range > 0` -> `1 / (range * range)` (standard quartic factor).
 *
 * @param range meters (component schema field `range`); `+Infinity` is the
 *              KHR no-truncation default
 * @returns `1 / range^2` with three-branch NaN protection
 */
export function computeInvRangeSquared(range: number): number {
  if (range === Number.POSITIVE_INFINITY) return 0;
  if (range === 0) return RANGE_ZERO_FALLBACK_INV_R2;
  return 1 / (range * range);
}

/**
 * feat-20260709 M2 / D-1: shared zero/missing-direction validate for
 * DirectionalLight + SpotLight. `direction` has no layer-2 default, so an
 * omitted direction lands the array layer-3 all-zero -- the same illegal state
 * as an explicit zero vector. SSOT for the rejection so the two lights cannot
 * drift. Returns the structured error to reject, or `null` when the direction
 * is a valid non-zero vector.
 */
export function validateDirection(
  componentName: 'DirectionalLight' | 'SpotLight',
  direction: ArrayLike<number> | undefined,
): SpawnLightInvalidBoundsError | null {
  const dir = direction;
  if (dir === undefined || ((dir[0] ?? 0) === 0 && (dir[1] ?? 0) === 0 && (dir[2] ?? 0) === 0)) {
    return new SpawnLightInvalidBoundsError(
      componentName,
      'direction',
      dir === undefined ? [0, 0, 0] : [dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0],
    );
  }
  return null;
}
