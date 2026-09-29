import type { FogFrame } from '../extract/environment';

/** Numerical reference for the shader's closed-form height-density integral. */
export function analyticFogOpacity(
  fog: Pick<FogFrame, 'density' | 'heightFalloff' | 'maxOpacity'>,
  originY: number,
  endY: number,
  distance: number,
): number {
  const rho = fog.density * Math.exp(Math.max(-60, Math.min(60, -fog.heightFalloff * originY)));
  const t = Math.max(-60, Math.min(60, fog.heightFalloff * (endY - originY)));
  const integral = Math.abs(t) < 0.001 ? 1 - t / 2 + (t * t) / 6 : -Math.expm1(-t) / t;
  return fog.maxOpacity * -Math.expm1(-Math.min(80, Math.max(0, rho * distance * integral)));
}
