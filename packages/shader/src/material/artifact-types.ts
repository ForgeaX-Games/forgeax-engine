import type {
  MaterialProgramAbi,
  MaterialProgramResourceSlot,
  MaterialProgramVertexInput,
  MaterialSurfaceProgramAbi,
} from '@forgeax/engine-types';
import {
  type BindGroupLayoutDescriptor,
  derive,
  isMaterialProgramAbi,
  type MaterialParticleInput,
  type ParamSchemaEntry,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
} from '@forgeax/engine-types';
import type { MaterialShaderProgram } from './program.js';

/** Runtime shader aliases keep the shader package vocabulary stable while the
 * ABI POD itself remains owned by the dependency-free types package. */
export type MaterialShaderResourceSlot = MaterialProgramResourceSlot;
export type MaterialShaderVertexInput = MaterialProgramVertexInput;
export type MaterialShaderArtifactReceipt = MaterialProgramAbi;

export interface MaterialShaderArtifact {
  readonly material: string;
  readonly pass: string;
  readonly program: MaterialShaderProgram;
  readonly layoutIdentity: string;
  /** Naga-reflected UV set count used to derive clamp-to-last vertex aliases. */
  readonly uvSetCount?: number;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  /** Producer-selected entry metadata for a concrete Pass, when authored. */
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  /** Exact manifest variant selected by the producer, when one exists. */
  readonly variantSet?: string;
  /** Reflection-owned dynamic values supplied by a VFX renderer. */
  readonly particleInputs?: readonly MaterialParticleInput[];
  readonly specializationKey?: string;
  /** Producer-owned ABI facts shared by direct and scene-index consumers. */
  readonly receipt?: MaterialShaderArtifactReceipt;
}

/**
 * Canonical Standard material schema consumed by the scene-index row.
 * Physical texture handles stay in the reserved physical injection range; their
 * numeric factors remain in this row, after the base user texture
 * coordinate pairs. Keeping this projection beside the receipt lets the
 * shader producer and the render-side table consume one schema identity.
 */
export const STANDARD_PIPELINE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (entry) =>
      !(
        entry.type.startsWith('texture') &&
        STANDARD_PHYSICAL_TEXTURE_FIELDS.includes(
          entry.name as (typeof STANDARD_PHYSICAL_TEXTURE_FIELDS)[number],
        )
      ),
  );

const STANDARD_PIPELINE_DERIVED = derive(STANDARD_PIPELINE_PARAM_SCHEMA);

/** Canonical Standard owns the shared GPU Scene stride. Smaller custom rows
 * are padded to this derived size by the compiler and runtime row writer. */
export const GPU_DRIVEN_MATERIAL_ROW_BYTES = STANDARD_PIPELINE_DERIVED.totalBytes;

function materialRowFields(
  schema: readonly ParamSchemaEntry[],
  derived: ReturnType<typeof derive>,
): readonly string[] {
  const coordinates = new Map(
    derived.coordinateRecords.map((record) => [record.parameter, record]),
  );
  return schema.flatMap((entry) => {
    if (isNumericParam(entry)) return [entry.name];
    if (entry.type.startsWith('texture')) {
      const record = coordinates.get(entry.name);
      if (record === undefined) throw new Error(`missing coordinate record for ${entry.name}`);
      return [record.transformMember, record.metadataMember];
    }
    return [];
  });
}

function isNumericParam(entry: ParamSchemaEntry): boolean {
  return (
    entry.type === 'f32' ||
    entry.type === 'i32' ||
    entry.type === 'u32' ||
    entry.type === 'vec2' ||
    entry.type === 'vec3' ||
    entry.type === 'vec4' ||
    entry.type === 'color'
  );
}

function standardPbrMaterialRowFields(): readonly string[] {
  return materialRowFields(STANDARD_PIPELINE_PARAM_SCHEMA, STANDARD_PIPELINE_DERIVED);
}

const STANDARD_PBR_VERTEX_INPUTS: readonly MaterialShaderVertexInput[] = [
  { semantic: 'position', location: 0, format: 'float32x3' },
  { semantic: 'normal', location: 1, format: 'float32x3' },
  { semantic: 'uv', location: 2, format: 'float32x2' },
  { semantic: 'tangent', location: 3, format: 'float32x4' },
];

function standardPbrResourceSlots(): MaterialShaderResourceSlot[] {
  return STANDARD_PIPELINE_DERIVED.resourceBindings.flatMap((resource) => {
    if (resource.kind !== 'sampler' && resource.kind !== 'texture') return [];
    return [
      {
        name: resource.name,
        parameter: resource.parameter ?? resource.name,
        kind: resource.kind,
        group: 1,
        binding: resource.binding,
      },
    ];
  });
}

/**
 * Builds the one Standard PBR ABI receipt consumed by both material lanes.
 * The skinned module uses the same material producer and only adds its palette
 * address; it must retain the same receipt identity for material compatibility.
 */
export function createStandardPbrArtifactReceipt(
  skinned = false,
  vertexColorAvailable = false,
): MaterialShaderArtifactReceipt & { readonly sceneIndexEntry: string } {
  const resourceSlots = standardPbrResourceSlots();
  const uvSets = STANDARD_PIPELINE_DERIVED.coordinateRecords.map((record) => ({
    parameter: record.parameter,
    set: 0,
  }));
  const vertexInputs = [
    ...STANDARD_PBR_VERTEX_INPUTS,
    ...(skinned
      ? [
          { semantic: 'skinIndex', location: 4, format: 'uint16x4' },
          { semantic: 'skinWeight', location: 5, format: 'float32x4' },
        ]
      : []),
    ...(vertexColorAvailable ? [{ semantic: 'color', location: 13, format: 'float32x4' }] : []),
  ];
  const layoutIdentity = `standard-pbr/material-row-v4${vertexColorAvailable ? '/vertex-color' : ''}`;
  return {
    directEntry: 'vs_main',
    sceneIndexEntry: 'vs_scene_index',
    materialRow: {
      byteLength: GPU_DRIVEN_MATERIAL_ROW_BYTES,
      fields: [...standardPbrMaterialRowFields()],
    },
    resourceSlots,
    uvSets,
    vertexInputs,
    alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
    ...(skinned ? { skinPaletteAddress: { group: 2, binding: 1, stride: 64 } } : {}),
    reflection: {
      layoutIdentity,
      resourceSlots,
      vertexInputs,
    },
    receiptIdentity: layoutIdentity,
    generation: 3,
  };
}

export interface MaterialProgramArtifactReceiptInput {
  readonly schema: readonly ParamSchemaEntry[];
  readonly directEntry: string;
  readonly sceneIndexEntry?: string;
  readonly vertexInputs: readonly MaterialShaderVertexInput[];
  readonly layoutIdentity?: string;
  readonly alphaMask?: { readonly cutoff: string; readonly source: string };
  readonly skinPaletteAddress?: {
    readonly group: number;
    readonly binding: number;
    readonly stride: number;
  };
  /** Storage row page used by the renderer-owned GPU Scene material table. */
  readonly rowStride?: number;
  /** Optional producer-owned Surface model projection. */
  readonly surface?: MaterialSurfaceProgramAbi;
}

/**
 * Build a receipt for a compiler-controlled custom material.  The receipt is
 * derived from the effective parameter schema; no shader identifier or
 * Standard field inventory participates in admission.  A producer may use a
 * smaller schema. Direct-only programs retain its actual aligned size; programs
 * with a scene-index entry use the shared GPU Scene storage-array page.
 */
export function createMaterialProgramArtifactReceipt(
  input: MaterialProgramArtifactReceiptInput,
): MaterialShaderArtifactReceipt {
  const derived = derive(input.schema);
  const rowStride =
    input.rowStride ??
    (input.sceneIndexEntry === undefined ? derived.totalBytes : GPU_DRIVEN_MATERIAL_ROW_BYTES);
  if (!Number.isSafeInteger(rowStride) || rowStride <= 0 || rowStride % 16 !== 0) {
    throw new RangeError('material program row stride must be a positive 16-byte multiple');
  }
  if (derived.totalBytes > rowStride) {
    throw new RangeError(
      `material program schema requires ${derived.totalBytes} bytes, larger than the ${rowStride}-byte GPU Scene page`,
    );
  }
  const resourceSlots = derived.resourceBindings.map((resource) => ({
    name: resource.name,
    parameter: resource.parameter ?? resource.name,
    kind: resource.kind,
    group: 1,
    binding: resource.binding,
  }));
  const uvSets = derived.coordinateRecords.map((record) => ({
    parameter: record.parameter,
    set: 0,
  }));
  const vertexIdentity = input.vertexInputs
    .map((vertex) => `${vertex.semantic}@${vertex.location}:${vertex.format}`)
    .join('|');
  const layoutIdentity =
    input.layoutIdentity ??
    `material-program/${derived.layoutIdentity}/row-${rowStride}/vertex-${vertexIdentity}`;
  // Standard receipts use the explicit producer factory above. Full-custom
  // coverage is authored by the selected Pass; inferring `alphaCutoff` from a
  // schema would classify an opaque program as masked and make its shadow lane
  // read the wrong value.
  const alphaMask = input.alphaMask ?? { cutoff: '', source: '' };
  return {
    directEntry: input.directEntry,
    ...(input.sceneIndexEntry === undefined ? {} : { sceneIndexEntry: input.sceneIndexEntry }),
    materialRow: {
      byteLength: rowStride,
      fields: [...materialRowFields(input.schema, derived)],
    },
    resourceSlots,
    uvSets,
    vertexInputs: [...input.vertexInputs],
    alphaMask,
    ...(input.skinPaletteAddress === undefined
      ? {}
      : { skinPaletteAddress: input.skinPaletteAddress }),
    reflection: {
      layoutIdentity,
      resourceSlots,
      vertexInputs: [...input.vertexInputs],
    },
    receiptIdentity: layoutIdentity,
    generation: 3,
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };
}

export function isMaterialShaderArtifact(value: unknown): value is MaterialShaderArtifact {
  if (value === null || typeof value !== 'object') return false;
  const artifact = value as Partial<MaterialShaderArtifact>;
  const particleInputs = artifact.particleInputs;
  const particleInputsValid =
    particleInputs === undefined ||
    (Array.isArray(particleInputs) &&
      particleInputs.every(
        (input) =>
          input !== null &&
          typeof input === 'object' &&
          typeof input.name === 'string' &&
          typeof input.type === 'string' &&
          typeof input.visibility === 'string' &&
          Number.isInteger(input.lane) &&
          input.lane >= 0,
      ));
  return (
    typeof artifact.material === 'string' &&
    typeof artifact.pass === 'string' &&
    artifact.program !== undefined &&
    artifact.program !== null &&
    typeof artifact.program.source === 'string' &&
    typeof artifact.program.identity === 'string' &&
    ['mesh', 'skin', 'cluster', 'skin-cluster'].includes(artifact.program.group2) &&
    typeof artifact.program.probeBlendRecordRequired === 'boolean' &&
    typeof artifact.layoutIdentity === 'string' &&
    Array.isArray(artifact.bindings) &&
    Array.isArray(artifact.deps) &&
    Array.isArray(artifact.vertexInputs) &&
    particleInputsValid
  );
}

/** Validate producer-published ABI facts before they enter the runtime catalog. */
export const isMaterialShaderArtifactReceipt = isMaterialProgramAbi;
