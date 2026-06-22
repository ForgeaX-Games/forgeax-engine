// color.ts — RGBA color namespace (M5 / T-032)
//
// 6-function surface: create / clone / srgbToLinear / linearToSrgb / fromHex / toHex
//
// Design anchors:
//   - branded Float32Array length 4 [r, g, b, a]; `as Color` casts are funneled inside factories (D-P15)
//   - sRGB ↔ linear: IEC 61966-2-1 piecewise gamma; RGB channels only, alpha pass-through
//     - srgbToLinear: cutoff 0.04045 / linear segment v/12.92 / power segment ((v+0.055)/1.055)^2.4
//     - linearToSrgb: cutoff 0.0031308 / linear segment 12.92*v / power segment 1.055*v^(1/2.4) - 0.055
//     - negatives / NaN returned verbatim (HDR-friendly + IEEE-754 NaN propagation)
//   - fromHex (D-P7): only `#RRGGBB` (7 chars) and `#RRGGBBAA` (9 chars); illegal inputs silently fall
//     back to (0, 0, 0, 1) without throwing (D-P12 degenerate family / AC-06)
//     - #RGB / #RGBA short forms are not supported (stricter than bevy_color::Srgba::hex; less ambiguous
//       in practice; wiki/sources/2026-05-05-bevy-0-19-math-transform-color §Srgba::hex mentions short
//       forms but D-P7 actively tightens the contract)
//   - toHex: alpha=1 → `#rrggbb`; alpha<1 → `#rrggbbaa`; components are clamped to [0, 1] then
//     multiplied by 255 and rounded; output is lowercase, symmetric with fromHex's tolerant input
//
// Related: requirements §Surface color lower bound 6 + AC-06 silent fall-back (never raises);
//          plan-strategy D-P7 / D-P12 / §appendix A degenerate registry #14-#16;
//          wiki/sources/2026-05-05-bevy-0-19-math-transform-color §sRGB piecewise gamma;
//          wiki/glam-rs-overview §LinearRgba.

import type { Color, ColorLike } from './types';

export type { Color, ColorLike };

// === create / copy ===

/** Create a Color (default RGBA = (0, 0, 0, 1) = opaque black). */
export function create(r = 0, g = 0, b = 0, a = 1): Color {
  return Float32Array.of(r, g, b, a) as Color;
}

/** Allocate a new Color copy. */
export function clone(c: ColorLike): Color {
  return Float32Array.of(c[0] as number, c[1] as number, c[2] as number, c[3] as number) as Color;
}

// === sRGB ↔ linear (IEC 61966-2-1 piecewise gamma) ===

/**
 * Single-channel sRGB → linear (component-level helper).
 *
 * @degrade NaN input → NaN output (IEEE-754 arithmetic propagation); negatives returned verbatim
 * to preserve HDR / specialized rendering needs (same convention as bevy_color::gamma_function;
 * wiki/sources bevy-0-19-color §gamma_function).
 *
 * @example
 * ```ts
 * srgbChannelToLinear(NaN);  // → NaN (IEEE-754 propagation)
 * srgbChannelToLinear(-0.1); // → -0.1 (HDR / negative kept verbatim)
 * ```
 */
function srgbChannelToLinear(v: number): number {
  if (Number.isNaN(v)) return Number.NaN;
  if (v <= 0) return v;
  if (v <= 0.04045) return v / 12.92;
  return ((v + 0.055) / 1.055) ** 2.4;
}

/** Single-channel linear → sRGB (component-level helper). */
function linearChannelToSrgb(v: number): number {
  if (Number.isNaN(v)) return Number.NaN;
  if (v <= 0) return v;
  if (v <= 0.0031308) return v * 12.92;
  return 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * out = sRGB → linear conversion (RGB channels only; alpha passed through).
 *
 * @degrade NaN propagation / negatives returned verbatim (HDR-friendly); alpha is strictly untouched.
 *
 * @example
 * ```ts
 * color.srgbToLinear(out, color.create(NaN, -0.1, 0.5, 0.8));
 * // → out = (NaN, -0.1, ~0.214, 0.8); alpha 0.8 passed through unchanged.
 * ```
 */
export function srgbToLinear(out: Color, c: ColorLike): Color {
  out[0] = srgbChannelToLinear(c[0] as number);
  out[1] = srgbChannelToLinear(c[1] as number);
  out[2] = srgbChannelToLinear(c[2] as number);
  out[3] = c[3] as number;
  return out;
}

/**
 * out = linear → sRGB conversion (RGB channels only; alpha passed through).
 *
 * @degrade NaN propagation / negatives returned verbatim; alpha is strictly untouched.
 *
 * @example
 * ```ts
 * color.linearToSrgb(out, color.create(NaN, -0.05, 0.5, 1));
 * // → out = (NaN, -0.05, ~0.735, 1); alpha is strictly untouched.
 * ```
 */
export function linearToSrgb(out: Color, c: ColorLike): Color {
  out[0] = linearChannelToSrgb(c[0] as number);
  out[1] = linearChannelToSrgb(c[1] as number);
  out[2] = linearChannelToSrgb(c[2] as number);
  out[3] = c[3] as number;
  return out;
}

// === Hex parse / serialize ===

const HEX_PATTERN = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/;

/**
 * Write a Color from a hex string.
 *
 * Only supports the two forms `#RRGGBB` (7 chars) and `#RRGGBBAA` (9 chars) (D-P7);
 * the CSS-style `#RGB` / `#RGBA` short forms are not supported.
 *
 * @degrade Any illegal input (short form / non-hex chars / missing # / wrong length / empty string,
 * etc.) silently falls back to (0, 0, 0, 1); never throws (D-P12 / AC-06).
 *
 * @example
 * ```ts
 * color.fromHex(out, '#ff8000');   // → (1, 0.502, 0, 1)
 * color.fromHex(out, '#ff800080'); // → (1, 0.502, 0, 0.502)
 * color.fromHex(out, '#fff');      // → (0, 0, 0, 1) short form unsupported → silent fall-back
 * ```
 */
export function fromHex(out: Color, hex: string): Color {
  const match = typeof hex === 'string' ? HEX_PATTERN.exec(hex) : null;
  if (match === null) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
  }
  out[0] = Number.parseInt(match[1] as string, 16) / 255;
  out[1] = Number.parseInt(match[2] as string, 16) / 255;
  out[2] = Number.parseInt(match[3] as string, 16) / 255;
  out[3] = match[4] !== undefined ? Number.parseInt(match[4], 16) / 255 : 1;
  return out;
}

/** Per-component [0, 1] clamp + ×255 + round + 2-digit hex (lowercase). */
function toHexByte(v: number): string {
  if (Number.isNaN(v)) return '00';
  const clamped = Math.max(0, Math.min(1, v));
  const byte = Math.round(clamped * 255);
  return byte.toString(16).padStart(2, '0');
}

/**
 * Serialize as hex string: alpha=1 → `#rrggbb`; alpha<1 → `#rrggbbaa`.
 *
 * @degrade Out-of-range components (HDR > 1 / negatives) are clamped to [0, 1] then rounded;
 * **truncated** rather than throwing (symmetric with fromHex's silent fall-back). NaN components →
 * literal '00' (same byte as 0.0; prevents the hex-string builder from throwing; alpha=NaN takes the
 * alpha=1 path, emitting the short `#rrggbb` form).
 *
 * @example
 * ```ts
 * color.toHex(color.create(2, -0.1, 0.5, 1));    // → '#ff0080' (HDR/negative clamp)
 * color.toHex(color.create(1, 0, 0, 0.5));        // → '#ff000080'
 * color.toHex(color.create(NaN, 0, 0, NaN));      // → '#000000' (NaN→'00', alpha=NaN takes short form)
 * ```
 */
export function toHex(c: ColorLike): string {
  const r = toHexByte(c[0] as number);
  const g = toHexByte(c[1] as number);
  const b = toHexByte(c[2] as number);
  const aValue = c[3] as number;
  if (aValue >= 1 || Number.isNaN(aValue)) {
    return `#${r}${g}${b}`;
  }
  const a = toHexByte(aValue);
  return `#${r}${g}${b}${a}`;
}
