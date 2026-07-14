// easing.ts — easing-function namespace (solo round 20260713-233409)
//
// 2-function surface: smoothstep / smootherstep — the two most-used Hermite S-curves
// (GLSL `smoothstep`, Perlin's smootherstep; Bevy `EaseFunction::SmoothStep`/`SmootherStep`).
// Scalar time-remaps t → number: take a normalized parameter and return an eased value with
// zero endpoint derivatives (slow-in / slow-out). The growable home for Bevy's `EaseFunction`
// family — further variants (sine / quad / cubic / elastic) land here add-only.
//
// Both clamp the input to [0, 1] first (GLSL / Bevy semantics), so out-of-range t saturates
// to the endpoints rather than extrapolating the polynomial.

import { clamp } from './_internal/scalar';

/**
 * Smoothstep S-curve: `3t² − 2t³` on the clamped input. GLSL `smoothstep` (with edges 0/1),
 * Bevy `EaseFunction::SmoothStep`. f(0)=0, f(1)=1, f′(0)=f′(1)=0 (slow-in / slow-out).
 * Input clamped to [0, 1]. Use to ease a normalized time / lerp factor instead of a linear ramp.
 */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Smootherstep (Perlin) S-curve: `6t⁵ − 15t⁴ + 10t³` on the clamped input. Bevy
 * `EaseFunction::SmootherStep`. Like {@link smoothstep} but ALSO has zero 2nd derivatives at
 * the endpoints (f″(0)=f″(1)=0), so acceleration is continuous — a gentler, more natural ease.
 * Input clamped to [0, 1].
 */
export function smootherstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}
