// _internal/scalar.ts — scalar helper SSOT (D-P13 not exported from package)
//
// Provides the scalar-layer building blocks reused across the vec/mat/quat namespaces;
// avoids duplicate implementations.
// Not exported through src/index.ts; indirectly covered by the public API tests of the dim files
// (plan-strategy §4.1 exemption).
//
// Related: plan-strategy §1.1 file layering (_internal/scalar.ts) + D-P13 _internal not exported;
//          requirements §duplicate-code elimination strategy D mixed.

/**
 * Scalar linear interpolation. t is not clamped (extrapolation semantics preserved,
 * matches glam Vec3.lerp / wgpu-matrix).
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Numeric clamp into the closed interval [min, max]. Returns NaN when v is NaN (NaN propagation).
 */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Approximate equality: |a-b| ≤ epsilon. NaN inputs always return false (matches IEEE 754).
 * Default epsilon 1e-6 fits Float32 single-precision comparisons.
 */
export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) <= epsilon;
}

/**
 * 4-component Euclidean length sqrt(x²+y²+z²+w²). Hand-expanded to avoid the variadic overhead of
 * Math.hypot (research §Finding 5.2 hot-path optimization template).
 */
export function hypot4(x: number, y: number, z: number, w: number): number {
  return Math.sqrt(x * x + y * y + z * z + w * w);
}
