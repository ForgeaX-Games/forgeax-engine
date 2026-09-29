import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { AutoExposureCapabilityUnavailableError } from './inspection';

export type AutoExposureCapabilityFacts = Pick<
  RhiCaps,
  'compute' | 'storageBuffer' | 'float32Filterable' | 'rgba16floatRenderable'
>;

export interface AutoExposureCapability {
  readonly available: true;
  readonly generation: number;
  readonly rgba16floatRenderable: boolean;
}

function unavailable(
  capability: 'compute' | 'storage-buffer' | 'float-filterable',
  generation: number,
): Result<never, AutoExposureCapabilityUnavailableError> {
  return err(new AutoExposureCapabilityUnavailableError({ capability, generation }));
}

/** Resolve live device facts; no capability is inferred from a neighboring format. */
export function resolveAutoExposureCapability(
  caps: AutoExposureCapabilityFacts,
  generation: number,
): Result<AutoExposureCapability, AutoExposureCapabilityUnavailableError> {
  if (!caps.compute) return unavailable('compute', generation);
  if (!caps.storageBuffer) return unavailable('storage-buffer', generation);
  if (!caps.float32Filterable) return unavailable('float-filterable', generation);
  return ok(
    Object.freeze({
      available: true as const,
      generation,
      rgba16floatRenderable: caps.rgba16floatRenderable,
    }),
  );
}
