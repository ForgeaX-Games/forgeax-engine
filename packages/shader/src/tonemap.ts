/** Numeric mode IDs consumed by the built-in tonemap WGSL module. */
export const TONEMAP_SHADER_MODE = {
  none: 0,
  reinhardExtended: 1,
  linear: 2,
  cineon: 3,
  acesFilmic: 4,
  agx: 5,
  neutral: 6,
  reinhard: 7,
} as const;

export type TonemapShaderMode = (typeof TONEMAP_SHADER_MODE)[keyof typeof TONEMAP_SHADER_MODE];
