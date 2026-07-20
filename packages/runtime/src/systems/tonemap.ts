// @forgeax/engine-runtime - TS port of the WGSL luminance Reinhard
// extended tonemap (feat-20260519-tonemap-reinhard-mvp / M3 / T-M3.2).
//
// Mirrors the fragment-stage formula in `packages/shader/src/tonemap.wgsl`
// byte-for-byte so AI users (and tests) can predict GPU output without
// allocating a device:
//
//   exposed = L_in * exposure
//   Y       = dot(exposed, vec3(0.2126, 0.7152, 0.0722))   // Rec. 709
//   Y_prime = Y * (1 + Y / (Lw * Lw)) / (1 + Y)
//   scale   = Y_prime / max(Y, TONEMAP_LUMINANCE_EPSILON)
//   L_out   = exposed * scale
//
// The `max(Y, TONEMAP_LUMINANCE_EPSILON)` floor keeps the divisor finite
// at degenerate inputs (`Y = 0` from black pixels, `Y < 0` from numerical
// artefacts). The constant is shared with the WGSL fragment via
// `@forgeax/engine-shader#TONEMAP_LUMINANCE_EPSILON` (D-O3 single SSOT;
// `1e-5`).

import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';

/** Rec. 709 luminance weights — match the `vec3(0.2126, 0.7152, 0.0722)`
 *  literal in `packages/shader/src/tonemap.wgsl` byte-for-byte. */
export const REC709_LUMA_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722] as const);

/**
 * Compute the post-tonemap LDR colour for a single linear HDR sample.
 *
 * Pure function: no GPU device, no allocation cost beyond the 3-element
 * tuple return. Tests use this to assert the shader-side formula without
 * spinning up a real adapter (charter proposition 5 consistent abstraction
 * — TS port and WGSL fragment share the constant + the formula).
 *
 * @param l_in    Linear HDR sample as `[r, g, b]` (typically read out of
 *                an `rgba16float` colour attachment).
 * @param exposure Pre-multiplier applied before the luminance computation.
 *                 Values <= 0 are still safe — the floor on Y guarantees
 *                 a finite result (NaN / Inf cannot escape).
 * @param whitePoint Bright-end break point Lw. Values <= 0 fall through
 *                   the same floor; large values approach the basic
 *                   Reinhard curve `Y / (1 + Y)`.
 *
 * @returns Tonemapped LDR colour as `[r, g, b]`. Each channel is finite
 *          provided `l_in` is finite; clamp to `[0, 1]` at the call site
 *          if the consumer needs strict swap-chain bounds.
 */
export function tonemapReinhardLuminance(
  l_in: readonly [number, number, number],
  exposure: number,
  whitePoint: number,
): [number, number, number] {
  const exposedR = (l_in[0] ?? 0) * exposure;
  const exposedG = (l_in[1] ?? 0) * exposure;
  const exposedB = (l_in[2] ?? 0) * exposure;

  const wR = REC709_LUMA_WEIGHTS[0];
  const wG = REC709_LUMA_WEIGHTS[1];
  const wB = REC709_LUMA_WEIGHTS[2];

  const luma = exposedR * wR + exposedG * wG + exposedB * wB;
  const lwSq = whitePoint * whitePoint;
  const lumaPrime = (luma * (1 + luma / lwSq)) / (1 + luma);
  const scale = lumaPrime / Math.max(luma, TONEMAP_LUMINANCE_EPSILON);

  return [exposedR * scale, exposedG * scale, exposedB * scale];
}

export { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';
