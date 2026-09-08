import type { ParamSchemaEntry } from '@forgeax/engine-types';

export const STANDARD_PBR_ALPHA_CUTOFF_DEFAULT = 0;

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
  { name: 'alphaCutoff', type: 'f32', default: STANDARD_PBR_ALPHA_CUTOFF_DEFAULT },
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0.5 },
  { name: 'specularTint', type: 'vec3', colorSpace: 'srgb', default: [1, 1, 1] },
  { name: 'normalScale', type: 'f32', default: 1 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'specularTintTexture', type: 'texture2d' },
  { name: 'emissiveTexture', type: 'texture2d' },
  { name: 'occlusionTexture', type: 'texture2d' },
];

export const DEFAULT_UNLIT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'baseColorTexture', type: 'texture2d' },
];

export const DEFAULT_SPRITE_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'colorTint', type: 'vec4', colorSpace: 'srgb', default: [1, 1, 1, 1] },
  { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
  { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
  { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

export const DEFAULT_MSDF_TEXT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
];
