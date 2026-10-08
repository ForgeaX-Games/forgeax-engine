import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from './assembly/device-feature-admission';
import { isCanonicalStandardPbrMaterialShader } from './pbr-pipeline';
import { resolveMaterialSnapshot } from './render-system-extract';

/** WebGPU's guaranteed `maxSampledTexturesPerShaderStage`: the portable authoring budget. */
export const WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE = 16;

/**
 * How one Standard material fits a per-stage sampled-texture limit. Ordinary
 * and `shared` transmission materials use the fixed 16-texture layout;
 * `dedicated` and `exceeded` need the full transmission layout, and an
 * `exceeded` material renders without refraction at this limit.
 */
export interface MaterialSampledTextureBudget {
  readonly limit: number;
  readonly required: number;
  readonly transmission: 'none' | 'dedicated' | 'shared' | 'exceeded';
  /** Authored split scalar maps that block the shared transmission layout. */
  readonly conflicts: readonly string[];
}

/**
 * Evaluate a material's Standard sampled-texture budget through the same
 * snapshot resolution and admission the renderer applies when recording.
 * Returns `undefined` for custom shaders, which own their layout.
 */
export function materialSampledTextureBudget(
  world: World,
  assets: AssetRegistry,
  materialHandle: number,
  limit: number = WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
): MaterialSampledTextureBudget | undefined {
  const material = resolveMaterialSnapshot(materialHandle, world, assets);
  if (!isCanonicalStandardPbrMaterialShader(material.materialShaderId)) return undefined;
  const admission = standardTransmissionAdmission(material, limit);
  const transmission = admission?.kind ?? 'none';
  return {
    limit,
    required:
      transmission === 'dedicated' || transmission === 'exceeded'
        ? STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
        : WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
    transmission,
    conflicts: admission?.kind === 'exceeded' ? admission.conflicts : [],
  };
}
