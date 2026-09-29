// @forgeax/engine-render - closed Directional shadow filter vocabulary.

/** Stable serialized labels for Directional shadow filtering. */
export const DirectionalShadowFilterValue = Object.freeze({
  pcf1: 1,
  pcf3: 2,
  pcf5: 3,
  pcssMedium: 4,
  pcssHigh: 5,
} as const);

export type DirectionalShadowFilterLabel = keyof typeof DirectionalShadowFilterValue;

/**
 * Extract-side semantic projection of the serialized Directional filter.
 * `shadowAngularRadius` is radians and `maxPenumbraTexels` is a finite integer.
 */
export type DirectionalShadowQuality =
  | { readonly kind: 'pcf'; readonly kernel: 1 | 3 | 5 }
  | {
      readonly kind: 'pcss';
      readonly preset: 'medium' | 'high';
      readonly angularRadiusRadians: number;
      readonly maxPenumbraTexels: number;
    };

/** Resolve the closed serialized label to the receiver-facing semantic union. */
export function directionalShadowQualityFromF32(
  value: number,
  angularRadiusRadians: number,
  maxPenumbraTexels: number,
): DirectionalShadowQuality | undefined {
  switch (value) {
    case DirectionalShadowFilterValue.pcf1:
      return { kind: 'pcf', kernel: 1 };
    case DirectionalShadowFilterValue.pcf3:
      return { kind: 'pcf', kernel: 3 };
    case DirectionalShadowFilterValue.pcf5:
      return { kind: 'pcf', kernel: 5 };
    case DirectionalShadowFilterValue.pcssMedium:
      return {
        kind: 'pcss',
        preset: 'medium',
        angularRadiusRadians,
        maxPenumbraTexels,
      };
    case DirectionalShadowFilterValue.pcssHigh:
      return {
        kind: 'pcss',
        preset: 'high',
        angularRadiusRadians,
        maxPenumbraTexels,
      };
    default:
      return undefined;
  }
}
