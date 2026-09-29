import type { ParamSchemaEntry } from '@forgeax/engine-types';
import {
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_PHYSICAL_PARAMETER_NAMES,
} from '@forgeax/engine-types';
import {
  STANDARD_PIPELINE_PARAM_SCHEMA as CANONICAL_STANDARD_PIPELINE_PARAM_SCHEMA,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifactReceipt,
} from './material/artifact-types.js';

export const STANDARD_PBR_ALPHA_CUTOFF_DEFAULT = 0;

/** Shared material contract for the standard PBR and skinned PBR shaders. */
export const DEFAULT_STANDARD_PBR_PARAM_SCHEMA = STANDARD_MATERIAL_PARAM_SCHEMA;

/** Numeric WGSL override ID, stable across Naga symbol mangling. */
export const STANDARD_TEXTURE_MASK_OVERRIDE = '64000';

/** Physical maps follow the fixed scene-material (46) and global-prefilter (47) slots. */
export const STANDARD_PHYSICAL_BINDING_START = 48;

const standardTextureBits: ReadonlyMap<string, number> = new Map(
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) => entry.type === 'texture2d').map(
    (entry, index) => [entry.name, 2 ** index],
  ),
);

/** Earlier Standard samples that an independent scalar map may reuse. */
export const STANDARD_SAMPLE_REUSE = [
  {
    target: 'metallicTexture',
    shift: standardTextureBits.size,
    sources: ['baseColorTexture', 'metallicRoughnessTexture'],
  },
  {
    target: 'roughnessTexture',
    shift: standardTextureBits.size + 2,
    sources: ['baseColorTexture', 'metallicRoughnessTexture', 'metallicTexture'],
  },
  {
    target: 'alphaTexture',
    shift: standardTextureBits.size + 4,
    sources: [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'metallicTexture',
      'roughnessTexture',
    ],
  },
] as const;

/** Presence follows the authored contract, never asynchronous GPU residency. */
export function standardTextureMask(schema: readonly ParamSchemaEntry[]): number {
  let mask = 0;
  for (const entry of schema) {
    if (entry.type === 'texture2d') mask |= standardTextureBits.get(entry.name) ?? 0;
  }
  return mask;
}

/** Pack sample reuse into unused high bits of the existing pipeline override. */
export function standardSampleReuseMask(
  presenceMask: number,
  sameSample: (source: string, target: string) => boolean,
): number {
  let mask = 0;
  for (const entry of STANDARD_SAMPLE_REUSE) {
    if ((presenceMask & (standardTextureBits.get(entry.target) ?? 0)) === 0) continue;
    for (const [index, source] of entry.sources.entries()) {
      if ((presenceMask & (standardTextureBits.get(source) ?? 0)) === 0) continue;
      if (!sameSample(source, entry.target)) continue;
      mask += (index + 1) * 2 ** entry.shift;
      break;
    }
  }
  return mask;
}

export type { StandardPhysicalTextureField } from '@forgeax/engine-types';
/**
 * Backward-compatible export name for callers that need the physical
 * projection.  Every entry is selected from the Standard root schema above;
 * no independent defaults or binding inventory can drift from it.
 */
/**
 * Stable physical texture injection order.  The order is part of the
 * Standard template's resource ABI and is derived from the root schema by
 * `standardPhysicalTextureFields`; render/cook must not maintain another
 * field inventory.
 */
export {
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';

export const STANDARD_PHYSICAL_LAYER_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) =>
    STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name),
  );

/**
 * Canonical static Standard entry.  It deliberately contains only the base
 * contract (including the specular extension) so a base-only material keeps
 * its Deferred path and carries no second-stage physical resources.
 */
export const STANDARD_BASE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
    (entry) =>
      !STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name) &&
      ![
        'transmission',
        'thickness',
        'attenuationColor',
        'attenuationDistance',
        'transmissionTexture',
        'thicknessTexture',
      ].includes(entry.name),
  );

/**
 * Canonical boot-time user region for the shared Standard material BGL.
 *
 * It is still a projection of the root schema, but unlike the author-facing
 * base-only projection it retains the pre-existing transmission texture pair.
 * The template reserves those two pairs before the IBL/backdrop injection so
 * a base-only shader and a transmissive shader can share one boot layout;
 * physical texture pairs are never included here and are appended only for a
 * root contract that declares them.
 */
// Keep the runtime schema export on the receipt producer's canonical
// projection.  The shader artifact, GPU Scene row, and material bind-group
// builder must not each filter the Standard root independently.
export const STANDARD_PIPELINE_PARAM_SCHEMA = CANONICAL_STANDARD_PIPELINE_PARAM_SCHEMA;

/**
 * Fixed material contract consumed by the VFX mesh adapters.
 *
 * `standard-surface.wgsl` is an authored surface rather than the generated
 * Standard root, so its Material block must be projected explicitly when a
 * particle shader is published. Keep the projection derived from the
 * canonical Standard vocabulary wherever possible; only the surface-owned
 * `specularTint` scalar and texture alias are local to this contract. The
 * order is the WGSL ABI: uniform region first (400 B), followed by eight
 * sampler/texture pairs (bindings 1..16), then the shared IBL injection at
 * bindings 17..22.
 */
const PARTICLE_SURFACE_NUMERIC_FIELDS = [
  'baseColor',
  'metallic',
  'roughness',
  'metallicChannel',
  'roughnessChannel',
  'aoChannel',
  'extraChannel',
  'emissive',
  'emissiveIntensity',
  'occlusionStrength',
  'alphaCutoff',
  'clearcoat',
  'clearcoatRoughness',
  'specularTint',
  'normalScale',
  'transmission',
  'ior',
  'thickness',
  'attenuationColor',
  'attenuationDistance',
] as const;

const PARTICLE_SURFACE_TEXTURE_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularTintTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
] as const;

function particleSurfaceSchemaEntry(name: string): ParamSchemaEntry {
  const entry = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find((candidate) => candidate.name === name);
  if (entry !== undefined) return entry;
  if (name === 'specularTint') {
    return { name, type: 'vec3', colorSpace: 'srgb', default: [1, 1, 1] };
  }
  if (name === 'specularTintTexture') return { name, type: 'texture2d' };
  throw new Error(`Particle Standard Surface schema field is missing: ${name}`);
}

export const PARTICLE_MESH_SURFACE_PARAM_SCHEMA: readonly ParamSchemaEntry[] = Object.freeze([
  ...PARTICLE_SURFACE_NUMERIC_FIELDS.map(particleSurfaceSchemaEntry),
  ...PARTICLE_SURFACE_TEXTURE_FIELDS.map(particleSurfaceSchemaEntry),
]);

/** The single producer receipt shared by direct and scene-index Standard PBR. */
export const STANDARD_PBR_ARTIFACT_RECEIPT: MaterialShaderArtifactReceipt =
  createStandardPbrArtifactReceipt();

/** Skinned Standard PBR keeps the material receipt identity and adds palette ABI. */
export const STANDARD_PBR_SKIN_ARTIFACT_RECEIPT: MaterialShaderArtifactReceipt =
  createStandardPbrArtifactReceipt(true);

export const DEFAULT_UNLIT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'alphaHash', type: 'f32', default: 0 },
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
