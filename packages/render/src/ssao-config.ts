// @forgeax/engine-render - SSAO parameter authority.

import { err, ok, type Result } from '@forgeax/engine-types';
import { PostProcessError } from './post-process-errors';

export const SSAO_DEFAULT_RADIUS = 0.5;
export const SSAO_DEFAULT_BIAS = 0.025;
export const SSAO_DEFAULT_INTENSITY = 1.0;

export interface SsaoParameterConfig {
  readonly radius?: number | undefined;
  readonly bias?: number | undefined;
  readonly intensity?: number | undefined;
}

export interface ResolvedSsaoParameters {
  readonly radius: number;
  readonly bias: number;
  readonly intensity: number;
}

/**
 * Apply the public defaults without deciding whether the values are valid.
 * The record stage uses this only after the graph build has validated the
 * active HDRP configuration, or for the disabled/default fallback payload.
 */
export function getSsaoParameters(config: SsaoParameterConfig | undefined): ResolvedSsaoParameters {
  return {
    radius: config?.radius ?? SSAO_DEFAULT_RADIUS,
    bias: config?.bias ?? SSAO_DEFAULT_BIAS,
    intensity: config?.intensity ?? SSAO_DEFAULT_INTENSITY,
  };
}

/**
 * Resolve and validate the SSAO configuration used by both graph routes.
 * Invalid values remain structured PostProcessErrors instead of becoming
 * NaNs or silently falling back to shader literals.
 */
export function resolveSsaoParameters(
  config: SsaoParameterConfig | undefined,
): Result<ResolvedSsaoParameters, PostProcessError> {
  const resolved = getSsaoParameters(config);
  if (resolved.radius <= 0) {
    return err(
      new PostProcessError({
        code: 'ssao-radius-non-positive',
        detail: { paramName: 'radius', value: resolved.radius },
      }),
    );
  }
  if (resolved.bias < 0) {
    return err(
      new PostProcessError({
        code: 'ssao-bias-negative',
        detail: { paramName: 'bias', value: resolved.bias },
      }),
    );
  }
  return ok(resolved);
}
