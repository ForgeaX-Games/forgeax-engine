import type { Tape } from '../protocol/types';

const RECORDED_CAPABILITY_FEATURES = [
  ['timestampQuery', 'timestamp-query'],
  ['textureCompressionBc', 'texture-compression-bc'],
  ['textureCompressionEtc2', 'texture-compression-etc2'],
  ['textureCompressionAstc', 'texture-compression-astc'],
  ['firstInstanceIndirect', 'indirect-first-instance'],
  ['float32Filterable', 'float32-filterable'],
  ['rg11b10ufloatRenderable', 'rg11b10ufloat-renderable'],
] as const satisfies readonly (readonly [string, GPUFeatureName])[];

/**
 * Build the strongest fresh WebGPU device the current adapter can provide for
 * a recorded tape. Optional features must be enabled, not merely advertised,
 * and replay receives concrete adapter limits instead of lower device defaults.
 */
export function replayDeviceRequest(
  tape: Tape,
  adapterFeatures: ReadonlySet<GPUFeatureName>,
  adapterLimits: Readonly<Record<string, number>>,
): GPUDeviceDescriptor {
  const requiredFeatures = RECORDED_CAPABILITY_FEATURES.filter(
    ([capability, feature]) =>
      tape.header.rhiCaps[capability] === true && adapterFeatures.has(feature),
  ).map(([, feature]) => feature);
  const limitEntries = Object.entries(adapterLimits).filter(
    ([, value]) => Number.isFinite(value) && value >= 0,
  );
  const request: GPUDeviceDescriptor = {};
  if (requiredFeatures.length > 0) request.requiredFeatures = requiredFeatures;
  if (limitEntries.length > 0) {
    request.requiredLimits = Object.fromEntries(limitEntries) as NonNullable<
      GPUDeviceDescriptor['requiredLimits']
    >;
  }
  return request;
}
