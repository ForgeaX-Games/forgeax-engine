import type { ParamSchemaEntry } from '@forgeax/engine-types';

/** Shared material contract for the standard PBR and skinned PBR shaders. */
export const DEFAULT_STANDARD_PBR_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'emissive', type: 'vec3', colorSpace: 'srgb', default: [0, 0, 0] },
  { name: 'emissiveIntensity', type: 'f32', default: 0 },
  { name: 'occlusionStrength', type: 'f32', default: 1 },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0.5 },
  { name: 'specularTint', type: 'vec3', colorSpace: 'srgb', default: [1, 1, 1] },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'specularTintTexture', type: 'texture2d' },
];
