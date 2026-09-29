import type { RhiAdapter, RhiDevice } from '@forgeax/engine-rhi';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from './shader-prewarm-policy';

const COMPRESSION_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
];

// The Standard transmission fragment ABI needs 21 sampled textures across its
// material, IBL, clustered-light, and SSAO bindings. Ordinary Standard draws
// omit both transmission maps and the backdrop and remain valid on the WebGPU minimum of
// 16. The extended-lighting topology reserves 24, so a device descriptor must
// request that larger limit when the adapter can provide it; adapter limits are
// not automatically inherited by requestDevice().
export { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES };

export function transmissionBackdropAvailable(limit: number | undefined): boolean {
  return limit === undefined || limit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES;
}
/**
 * The complete Standard physical root can declare all optional texture slots.
 * Its material group therefore needs two more sampled-texture entries than the
 * extended-lighting topology alone. Request this ceiling when the adapter can
 * provide it; lower-capability devices remain fail-closed at material
 * pipeline admission instead of receiving an invalid WebGPU layout.
 */
export const STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES = 26;

export interface DeviceFeatureAdmission {
  readonly requiredFeatures: GPUFeatureName[];
  readonly requiredLimits?: {
    readonly maxSampledTexturesPerShaderStage?: number;
    readonly maxColorAttachmentBytesPerSample?: number;
  };
}

type AdapterFeatureProbe = Pick<RhiAdapter, 'features'> & Partial<Pick<RhiAdapter, 'limits'>>;

export function deriveDeviceFeatureAdmission(adapter: AdapterFeatureProbe): DeviceFeatureAdmission {
  const requiredFeatures: GPUFeatureName[] = [
    'depth32float-stencil8',
    ...COMPRESSION_FEATURES.filter((feature) => adapter.features.has(feature)),
  ];
  // Two-phase GPU occlusion appends late draws after the early phase's items,
  // which needs a nonzero indirect `firstInstance`.
  if (adapter.features.has('indirect-first-instance')) {
    requiredFeatures.push('indirect-first-instance');
  }
  // Camera companions may enable DRS after device creation. Admitting the
  // feature allocates no queries; the timing owner still follows frame demand.
  if (adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query');
  }
  const adapterSampledTextureLimit = adapter.limits?.maxSampledTexturesPerShaderStage ?? 0;
  const visibleSurface =
    adapter.features.has('primitive-index') &&
    (adapter.limits?.maxColorAttachments ?? 0) >= 6 &&
    (adapter.limits?.maxColorAttachmentBytesPerSample ?? 0) >= 48;
  if (visibleSurface) requiredFeatures.push('primitive-index');
  const requiredSampledTextureLimit =
    adapterSampledTextureLimit >= STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
      ? STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
      : adapterSampledTextureLimit >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
        ? EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
        : adapterSampledTextureLimit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
          ? STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
          : undefined;
  return {
    requiredFeatures,
    ...(requiredSampledTextureLimit === undefined && !visibleSurface
      ? {}
      : {
          requiredLimits: {
            ...(requiredSampledTextureLimit === undefined
              ? {}
              : { maxSampledTexturesPerShaderStage: requiredSampledTextureLimit }),
            ...(visibleSurface ? { maxColorAttachmentBytesPerSample: 48 } : {}),
          },
        }),
  };
}

export function deviceOptionsForAdapter(
  adapter: AdapterFeatureProbe,
): DeviceFeatureAdmission | undefined {
  const admission = deriveDeviceFeatureAdmission(adapter);
  return admission.requiredFeatures.length === 0 && admission.requiredLimits === undefined
    ? undefined
    : admission;
}

export function isTimestampQueryAdmitted(
  caps: Pick<RhiDevice['caps'], 'timestampQuery' | 'timestampPeriodNanoseconds'>,
): boolean {
  return (
    caps.timestampQuery === true &&
    caps.timestampPeriodNanoseconds !== null &&
    Number.isFinite(caps.timestampPeriodNanoseconds) &&
    caps.timestampPeriodNanoseconds > 0
  );
}
