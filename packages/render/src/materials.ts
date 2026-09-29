import { color } from '@forgeax/engine-math';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import type {
  MaterialAsset,
  MaterialColorSpace,
  MaterialParameter,
  MaterialPass,
  MaterialRenderState,
  MaterialValue,
} from '@forgeax/engine-types';
import { deriveStandardLayerPlan, standardSurfaceParameters } from '@forgeax/engine-types';
import {
  DEFAULT_STANDARD_SURFACE_MODULE,
  projectStandardSurfacePasses,
} from './assembly/material/surface-projection';
import { shadowCasterRenderState } from './material-render-state';

export type MaterialTransmissionValidationReason =
  | 'non-finite'
  | 'range'
  | 'shape'
  | 'blend'
  | 'depth-write';

export type MaterialAuthoringValidationReason = 'non-finite' | 'range' | 'shape';

/** Structured authoring failure for a built-in Standard material parameter. */
export class MaterialAuthoringContractError extends Error {
  readonly code = 'material-authoring-contract-invalid' as const;
  readonly expected =
    'Standard material authoring values are finite and within their declared ranges';
  readonly hint: string;
  readonly detail: {
    readonly code: 'material-authoring-contract-invalid';
    readonly material: 'Standard';
    readonly parameter:
      | 'alphaCutoff'
      | 'normalScale'
      | 'bumpScale'
      | 'displacementScale'
      | 'displacementBias';
    readonly reason: MaterialAuthoringValidationReason;
    readonly actual?: unknown;
  };

  constructor(
    parameter: MaterialAuthoringContractError['detail']['parameter'],
    reason: MaterialAuthoringValidationReason,
    actual?: unknown,
  ) {
    super(`Materials.standard: ${parameter} violates the authoring contract (${reason})`);
    this.name = 'MaterialAuthoringContractError';
    this.hint = `set ${parameter} to ${parameter === 'normalScale' ? 'two finite numbers [x, y]' : 'a finite number'}${parameter === 'alphaCutoff' ? ' in [0, 1]' : ''} before publishing the material`;
    this.detail = {
      code: 'material-authoring-contract-invalid',
      material: 'Standard',
      parameter,
      reason,
      ...(actual === undefined ? {} : { actual }),
    };
  }
}

/** Structured authoring failure for the Standard transmission contract. */
export class MaterialTransmissionContractError extends Error {
  readonly code = 'material-transmission-contract-invalid' as const;
  readonly expected = 'transmission material values satisfy finite ranges and Forward depth rules';
  readonly hint =
    'repair the named transmission value or pass state before publishing the material';
  readonly detail: {
    readonly code: 'material-transmission-contract-invalid';
    readonly material: 'Standard';
    readonly parameter:
      | 'transmission'
      | 'ior'
      | 'thickness'
      | 'attenuationColor'
      | 'attenuationDistance';
    readonly reason: MaterialTransmissionValidationReason;
    readonly actual?: unknown;
  };

  constructor(
    parameter: (typeof MaterialTransmissionContractError.prototype.detail)['parameter'],
    reason: MaterialTransmissionValidationReason,
    actual?: unknown,
  ) {
    super(`Materials.standard: ${parameter} violates the transmission contract (${reason})`);
    this.name = 'MaterialTransmissionContractError';
    this.detail = {
      code: 'material-transmission-contract-invalid',
      material: 'Standard',
      parameter,
      reason,
      ...(actual === undefined ? {} : { actual }),
    };
  }
}

export const SPRITE_PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const UNLIT_MODULE = 'forgeax_material::unlit';
const SPRITE_MODULE = 'forgeax_material::sprite';

export type MaterialColorTuple3 = readonly [number, number, number];
export type MaterialColorTuple4 = readonly [number, number, number, number];
export type MaterialColorInput3 = MaterialColorTuple3 | string | number;
export type MaterialColorInput4 = MaterialColorTuple4 | string | number;

function colorHexFromNumber(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`material color number must be an integer in [0, 0xffffff], got ${value}`);
  }
  return `#${value.toString(16).padStart(6, '0')}`;
}

function linearColorFromInput(
  input: MaterialColorInput3 | MaterialColorInput4,
  channels: 3 | 4,
): readonly number[] {
  if (typeof input === 'number' || typeof input === 'string') {
    const parsed = color.create();
    color.fromCss(parsed, typeof input === 'number' ? colorHexFromNumber(input) : input);
    return channels === 3
      ? [parsed[0] as number, parsed[1] as number, parsed[2] as number]
      : Array.from(parsed);
  }
  if (input.length !== channels) {
    throw new Error(`material color tuple must contain ${channels} channels, got ${input.length}`);
  }
  return [...input];
}

/** Convert an explicit sRGB numeric tuple into the linear tuple factories store. */
export function srgb(input: MaterialColorTuple3): MaterialColorTuple3;
export function srgb(input: MaterialColorTuple4): MaterialColorTuple4;
export function srgb(input: readonly number[]): readonly number[] {
  if (input.length !== 3 && input.length !== 4) {
    throw new Error(`sRGB material color tuple must contain 3 or 4 channels, got ${input.length}`);
  }
  const parsed = color.create(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, input[3] ?? 1);
  color.srgbToLinear(parsed, parsed);
  return input.length === 3
    ? [parsed[0] as number, parsed[1] as number, parsed[2] as number]
    : [parsed[0] as number, parsed[1] as number, parsed[2] as number, parsed[3] as number];
}

function authoredColorParameter(
  name: string,
  type: 'color' | 'vec3',
  colorSpace: MaterialColorSpace,
  optional = false,
): MaterialParameter {
  return {
    name,
    type,
    ...(type === 'color' && colorSpace === 'srgb' ? {} : { colorSpace }),
    ...(optional ? { optional: true } : {}),
  };
}

function standardParameters(
  colorSpace: MaterialColorSpace,
  opts: StandardOpts,
): readonly MaterialParameter[] {
  const physicalNames = new Set<string>();
  const addPhysical = (...names: readonly string[]) => {
    for (const name of names) physicalNames.add(name);
  };
  if (
    opts.clearcoat !== undefined ||
    opts.clearcoatRoughness !== undefined ||
    opts.clearcoatNormalScale !== undefined ||
    opts.clearcoatTexture !== undefined ||
    opts.clearcoatRoughnessTexture !== undefined ||
    opts.clearcoatNormalTexture !== undefined
  ) {
    addPhysical(
      'clearcoat',
      'clearcoatRoughness',
      'clearcoatNormalScale',
      ...(opts.clearcoatTexture === undefined ? [] : ['clearcoatTexture']),
      ...(opts.clearcoatRoughnessTexture === undefined ? [] : ['clearcoatRoughnessTexture']),
      ...(opts.clearcoatNormalTexture === undefined ? [] : ['clearcoatNormalTexture']),
    );
  }
  if (
    opts.anisotropyStrength !== undefined ||
    opts.anisotropyRotation !== undefined ||
    opts.anisotropyTexture !== undefined
  ) {
    addPhysical('anisotropyStrength', 'anisotropyRotation');
    if (opts.anisotropyTexture !== undefined) addPhysical('anisotropyTexture');
  }
  if (
    opts.sheenColor !== undefined ||
    opts.sheenRoughness !== undefined ||
    opts.sheenColorTexture !== undefined ||
    opts.sheenRoughnessTexture !== undefined
  ) {
    addPhysical('sheenColor', 'sheenRoughness');
    if (opts.sheenColorTexture !== undefined) addPhysical('sheenColorTexture');
    if (opts.sheenRoughnessTexture !== undefined) addPhysical('sheenRoughnessTexture');
  }
  if (
    opts.diffuseTransmission !== undefined ||
    opts.diffuseTransmissionColor !== undefined ||
    opts.diffuseTransmissionTexture !== undefined ||
    opts.diffuseTransmissionColorTexture !== undefined
  ) {
    addPhysical('diffuseTransmission', 'diffuseTransmissionColor');
    if (opts.diffuseTransmissionTexture !== undefined) addPhysical('diffuseTransmissionTexture');
    if (opts.diffuseTransmissionColorTexture !== undefined) {
      addPhysical('diffuseTransmissionColorTexture');
    }
  }
  if (
    opts.iridescence !== undefined ||
    opts.iridescenceIor !== undefined ||
    opts.iridescenceThicknessMinimum !== undefined ||
    opts.iridescenceThicknessMaximum !== undefined ||
    opts.iridescenceTexture !== undefined ||
    opts.iridescenceThicknessTexture !== undefined
  ) {
    addPhysical(
      'iridescence',
      'iridescenceIor',
      'iridescenceThicknessMinimum',
      'iridescenceThicknessMaximum',
      ...(opts.iridescenceTexture === undefined ? [] : ['iridescenceTexture']),
      ...(opts.iridescenceThicknessTexture === undefined ? [] : ['iridescenceThicknessTexture']),
    );
  }
  const baseNames = new Set([
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
    'alphaHash',
    'normalScale',
    'bumpScale',
    'displacementScale',
    'displacementBias',
    'specular',
    'specularColor',
    // IOR is part of the always-present dielectric F0 contract. The
    // transmission layer may be absent, but the Standard shader still
    // consumes this scalar for the base reflection path.
    'ior',
  ]);
  if (opts.specularTexture !== undefined) baseNames.add('specularTexture');
  if (opts.specularColorTexture !== undefined) baseNames.add('specularColorTexture');
  if (
    opts.transmission !== undefined ||
    opts.ior !== undefined ||
    opts.thickness !== undefined ||
    opts.transmissionTexture !== undefined ||
    opts.thicknessTexture !== undefined ||
    opts.attenuationColor !== undefined ||
    opts.attenuationDistance !== undefined
  ) {
    for (const name of [
      'transmission',
      'ior',
      'thickness',
      'attenuationColor',
      'attenuationDistance',
    ]) {
      baseNames.add(name);
    }
  }
  // A texture declaration selects its compiled sampling path. Loading state
  // does not: an authored but not-yet-resident slot still needs its fallback.
  for (const parameter of DEFAULT_STANDARD_PBR_PARAM_SCHEMA) {
    if (
      parameter.type === 'texture2d' &&
      opts[parameter.name as keyof StandardOpts] !== undefined
    ) {
      baseNames.add(parameter.name);
    }
  }
  // All Standard fields come from one root schema. Physical fields are
  // projected by the authored option membership above; appending a second
  // physical schema would create a parallel ABI authority.
  const availableSchema = DEFAULT_STANDARD_PBR_PARAM_SCHEMA;
  // Keep the generated Standard UBO's numeric run contiguous before any
  // texture coordinate records. The built-in WGSL places the complete
  // physical root (including clearcoat scalars) after the base numeric run
  // and before all coordinate pairs; appending physical entries after the
  // base texture records would otherwise derive a different ABI.
  const numericSchema = availableSchema.filter((entry) => !entry.type.startsWith('texture'));
  const textureSchema = availableSchema.filter((entry) => entry.type.startsWith('texture'));
  const orderedSchema = [...numericSchema, ...textureSchema];
  return orderedSchema
    .filter((entry) => baseNames.has(entry.name) || physicalNames.has(entry.name))
    .map((entry) => {
      const type = entry.type.startsWith('texture') ? 'texture' : entry.type;
      const isRequired =
        entry.name === 'baseColor' || entry.name === 'metallic' || entry.name === 'roughness';
      const authoredColor =
        entry.type === 'color' || (entry.type === 'vec3' && entry.name !== 'attenuationColor');
      const schemaColorSpace = 'colorSpace' in entry ? entry.colorSpace : undefined;
      const colorSpaceProjection: { colorSpace?: MaterialColorSpace } = {};
      if (authoredColor && !(type === 'color' && colorSpace === 'srgb')) {
        colorSpaceProjection.colorSpace = colorSpace;
      } else if (!authoredColor && schemaColorSpace !== undefined) {
        colorSpaceProjection.colorSpace = schemaColorSpace;
      }
      return {
        name: entry.name,
        type,
        ...colorSpaceProjection,
        ...('default' in entry && entry.default !== undefined ? { default: entry.default } : {}),
        ...(isRequired ? {} : { optional: true }),
      } as MaterialParameter;
    });
}

function unlitParameters(colorSpace: MaterialColorSpace): readonly MaterialParameter[] {
  return [
    authoredColorParameter('baseColor', 'color', colorSpace),
    { name: 'alphaCutoff', type: 'f32', optional: true },
    { name: 'alphaHash', type: 'f32', optional: true },
    { name: 'baseColorTexture', type: 'texture', optional: true },
  ];
}

function pass(
  name: string,
  module: string,
  renderState: MaterialRenderState | undefined,
  fragmentEntry?: string,
  queue?: number,
): MaterialPass {
  const lightMode =
    name === 'shadow-caster' ? 'ShadowCaster' : name === 'deferred' ? 'Deferred' : 'Forward';
  const authoredState = (renderState ?? {}) as Readonly<Record<string, unknown>>;
  const authoredTags = authoredState.tags as Readonly<Record<string, string>> | undefined;
  return {
    name,
    program: {
      module,
      ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
    },
    renderState: {
      ...authoredState,
      tags: { LightMode: lightMode, ...authoredTags },
      ...(queue === undefined ? {} : { queue }),
    },
  };
}

interface UnlitOpts {
  readonly baseColorTexture?: MaterialValue;
  readonly alphaCutoff?: number;
  /** Object-space stochastic coverage. Keep blending disabled and depth writes enabled. */
  readonly alphaHash?: boolean;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
}

function unlit(rgba: MaterialColorInput4, opts?: UnlitOpts): MaterialAsset {
  if (opts?.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new Error(`Materials.unlit: alphaCutoff must be in [0, 1], got ${opts.alphaCutoff}`);
  }
  const values: Record<string, MaterialValue> = { baseColor: linearColorFromInput(rgba, 4) };
  if (opts?.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts?.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  if (opts?.alphaHash !== undefined) values.alphaHash = Number(opts.alphaHash);
  const passes: [MaterialPass, ...MaterialPass[]] = [
    pass('forward', UNLIT_MODULE, opts?.renderState, undefined, opts?.queue),
  ];
  const shadow = pass('shadow-caster', UNLIT_MODULE, shadowCasterRenderState(opts?.renderState));
  passes.push({ ...shadow, program: { ...shadow.program, vertexEntry: 'vs_shadow' } });
  return {
    kind: 'material',
    colorSpace: 'linear',
    passes,
    parameters: unlitParameters('linear'),
    values,
  };
}

interface StandardOpts {
  /** Numeric tuples are linear; Hex/CSS strings and numbers are sRGB inputs. */
  readonly baseColor: MaterialColorInput4;
  readonly metallic?: number;
  readonly roughness?: number;
  /** Texture channel used for the metallic factor; glTF defaults to B (2). */
  readonly metallicChannel?: number;
  /** Texture channel used for the roughness factor; glTF defaults to G (1). */
  readonly roughnessChannel?: number;
  /** Alpha map channel; Three.js defaults to G (1). */
  readonly alphaChannel?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  readonly clearcoatTexture?: MaterialValue;
  readonly clearcoatRoughnessTexture?: MaterialValue;
  readonly clearcoatNormalTexture?: MaterialValue;
  readonly clearcoatNormalScale?: number;
  readonly anisotropyStrength?: number;
  readonly anisotropyRotation?: number;
  readonly anisotropyTexture?: MaterialValue;
  readonly sheenColor?: MaterialColorInput3;
  readonly sheenRoughness?: number;
  readonly sheenColorTexture?: MaterialValue;
  readonly sheenRoughnessTexture?: MaterialValue;
  /**
   * Fraction of non-specular light transmitted diffusely through a thin
   * surface (KHR_materials_diffuse_transmission). Foliage and paper lit from
   * behind glow on the viewer side; pair with `renderState.cullMode: 'none'`.
   */
  readonly diffuseTransmission?: number;
  /** Linear tint of the transmitted light; it does not inherit baseColor. */
  readonly diffuseTransmissionColor?: MaterialColorInput3;
  /** Linear A channel multiplies `diffuseTransmission`. */
  readonly diffuseTransmissionTexture?: MaterialValue;
  /** sRGB RGB channels multiply `diffuseTransmissionColor`. */
  readonly diffuseTransmissionColorTexture?: MaterialValue;
  readonly iridescence?: number;
  readonly iridescenceIor?: number;
  readonly iridescenceThicknessMinimum?: number;
  readonly iridescenceThicknessMaximum?: number;
  readonly iridescenceTexture?: MaterialValue;
  readonly iridescenceThicknessTexture?: MaterialValue;
  readonly specular?: number;
  readonly specularColor?: MaterialColorInput3;
  readonly specularTexture?: MaterialValue;
  readonly specularColorTexture?: MaterialValue;
  readonly emissive?: MaterialColorInput3;
  readonly emissiveIntensity?: number;
  readonly emissiveTexture?: MaterialValue;
  readonly baseColorTexture?: MaterialValue;
  readonly metallicRoughnessTexture?: MaterialValue;
  /** Independent map overrides the corresponding packed metallic-roughness channel. */
  readonly metallicTexture?: MaterialValue;
  readonly roughnessTexture?: MaterialValue;
  /** Multiplies base-color and vertex opacity; uses the existing blend/cutoff policy. */
  readonly alphaTexture?: MaterialValue;
  readonly normalTexture?: MaterialValue;
  readonly normalScale?: readonly [number, number];
  readonly bumpTexture?: MaterialValue;
  readonly bumpScale?: number;
  /** Linear red height in [0, 1], sampled at mip zero. Requires sufficient mesh vertices. */
  readonly displacementTexture?: MaterialValue;
  /** Object-space displacement = height * scale + bias. Defaults to 1 and 0. */
  readonly displacementScale?: number;
  readonly displacementBias?: number;
  readonly occlusionTexture?: MaterialValue;
  readonly occlusionStrength?: number;
  readonly alphaCutoff?: number;
  /** Object-space stochastic coverage. Keep blending disabled and depth writes enabled. */
  readonly alphaHash?: boolean;
  readonly transmission?: number;
  readonly transmissionTexture?: MaterialValue;
  readonly ior?: number;
  readonly thickness?: number;
  readonly thicknessTexture?: MaterialValue;
  readonly attenuationColor?: readonly [number, number, number];
  readonly attenuationDistance?: number;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
}

/** Built-in Standard authoring surface with engine-owned parameter defaults. */
export interface DefaultStandardOptions extends StandardOpts {
  readonly surfaceModule?: never;
  readonly parameters?: never;
  readonly values?: never;
}

/** Import-first Standard Surface authoring; the root parameter contract stays caller-owned. */
export interface CustomStandardSurfaceOptions {
  readonly surfaceModule: string;
  readonly parameters: readonly MaterialParameter[];
  readonly values: Readonly<Record<string, MaterialValue>>;
  readonly colorSpace?: MaterialColorSpace;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
  readonly baseColor?: never;
  readonly metallic?: never;
  readonly roughness?: never;
  readonly metallicChannel?: never;
  readonly roughnessChannel?: never;
  readonly clearcoat?: never;
  readonly clearcoatRoughness?: never;
  readonly clearcoatTexture?: never;
  readonly clearcoatRoughnessTexture?: never;
  readonly clearcoatNormalTexture?: never;
  readonly clearcoatNormalScale?: never;
  readonly anisotropyStrength?: never;
  readonly anisotropyRotation?: never;
  readonly anisotropyTexture?: never;
  readonly sheenColor?: never;
  readonly sheenRoughness?: never;
  readonly sheenColorTexture?: never;
  readonly sheenRoughnessTexture?: never;
  readonly diffuseTransmission?: never;
  readonly diffuseTransmissionColor?: never;
  readonly diffuseTransmissionTexture?: never;
  readonly diffuseTransmissionColorTexture?: never;
  readonly iridescence?: never;
  readonly iridescenceIor?: never;
  readonly iridescenceThicknessMinimum?: never;
  readonly iridescenceThicknessMaximum?: never;
  readonly iridescenceTexture?: never;
  readonly iridescenceThicknessTexture?: never;
  readonly specular?: never;
  readonly specularColor?: never;
  readonly specularTexture?: never;
  readonly specularColorTexture?: never;
  readonly emissive?: never;
  readonly emissiveIntensity?: never;
  readonly emissiveTexture?: never;
  readonly baseColorTexture?: never;
  readonly metallicRoughnessTexture?: never;
  readonly metallicTexture?: never;
  readonly roughnessTexture?: never;
  readonly alphaTexture?: never;
  readonly alphaChannel?: never;
  readonly normalTexture?: never;
  readonly normalScale?: never;
  readonly bumpTexture?: never;
  readonly bumpScale?: never;
  readonly displacementTexture?: never;
  readonly displacementScale?: never;
  readonly displacementBias?: never;
  readonly occlusionTexture?: never;
  readonly occlusionStrength?: never;
  readonly alphaCutoff?: never;
  readonly alphaHash?: never;
  readonly transmission?: never;
  readonly transmissionTexture?: never;
  readonly ior?: never;
  readonly thickness?: never;
  readonly thicknessTexture?: never;
  readonly attenuationColor?: never;
  readonly attenuationDistance?: never;
}

export type StandardOptions = DefaultStandardOptions | CustomStandardSurfaceOptions;

function validateChannel(
  name: 'metallicChannel' | 'roughnessChannel' | 'alphaChannel',
  value: number | undefined,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 3)) {
    throw new Error(`Materials.standard: ${name} must be an integer in [0, 3], got ${value}`);
  }
}

function validateFiniteRange(
  name: 'transmission' | 'ior' | 'thickness' | 'attenuationDistance',
  value: number | undefined,
  minimum: number,
  maximum?: number,
): void {
  if (value === undefined || !Number.isFinite(value)) {
    if (value === undefined) return;
    throw new MaterialTransmissionContractError(name, 'non-finite', value);
  }
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    throw new MaterialTransmissionContractError(name, 'range', value);
  }
}

function standardDefault(opts: DefaultStandardOptions): MaterialAsset {
  const occlusionStrength = opts.occlusionStrength ?? 1;
  if (occlusionStrength < 0 || occlusionStrength > 1) {
    throw new Error(
      `Materials.standard: occlusionStrength must be in [0, 1], got ${occlusionStrength}`,
    );
  }
  if (opts.alphaCutoff !== undefined && !Number.isFinite(opts.alphaCutoff)) {
    throw new MaterialAuthoringContractError('alphaCutoff', 'non-finite', opts.alphaCutoff);
  }
  if (opts.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new MaterialAuthoringContractError('alphaCutoff', 'range', opts.alphaCutoff);
  }
  if (opts.normalScale !== undefined) {
    if (!Array.isArray(opts.normalScale) || opts.normalScale.length !== 2) {
      throw new MaterialAuthoringContractError('normalScale', 'shape', opts.normalScale);
    }
    if (!Number.isFinite(opts.normalScale[0]) || !Number.isFinite(opts.normalScale[1])) {
      throw new MaterialAuthoringContractError('normalScale', 'non-finite', opts.normalScale);
    }
  }
  if (opts.bumpScale !== undefined && !Number.isFinite(opts.bumpScale)) {
    throw new MaterialAuthoringContractError('bumpScale', 'non-finite', opts.bumpScale);
  }
  for (const name of ['displacementScale', 'displacementBias'] as const) {
    if (opts[name] !== undefined && !Number.isFinite(opts[name])) {
      throw new MaterialAuthoringContractError(name, 'non-finite', opts[name]);
    }
  }
  validateChannel('metallicChannel', opts.metallicChannel);
  validateChannel('roughnessChannel', opts.roughnessChannel);
  validateChannel('alphaChannel', opts.alphaChannel);
  const transmission = opts.transmission ?? 0;
  const ior = opts.ior ?? 1.5;
  const thickness = opts.thickness ?? 0;
  const attenuationColor = opts.attenuationColor ?? [1, 1, 1];
  validateFiniteRange('transmission', transmission, 0, 1);
  validateFiniteRange('ior', ior, 1);
  validateFiniteRange('thickness', thickness, 0);
  validateFiniteRange('attenuationDistance', opts.attenuationDistance, Number.MIN_VALUE);
  if (
    attenuationColor.length !== 3 ||
    attenuationColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new MaterialTransmissionContractError('attenuationColor', 'shape', attenuationColor);
  }
  if (transmission > 0 && opts.renderState?.blend !== undefined) {
    throw new MaterialTransmissionContractError('transmission', 'blend', opts.renderState.blend);
  }
  if (transmission > 0 && opts.renderState?.depthWriteEnabled === true) {
    throw new MaterialTransmissionContractError('transmission', 'depth-write', true);
  }
  const values: Record<string, MaterialValue> = {
    baseColor: linearColorFromInput(opts.baseColor, 4),
    metallic: opts.metallic ?? 0,
    roughness: opts.roughness ?? 0.5,
    occlusionStrength,
    displacementScale: opts.displacementScale ?? 1,
    displacementBias: opts.displacementBias ?? 0,
    specular: opts.specular ?? 1,
    specularColor:
      opts.specularColor === undefined ? [1, 1, 1] : linearColorFromInput(opts.specularColor, 3),
    transmission,
    ior,
    thickness,
    attenuationColor,
  };
  if (opts.metallicChannel !== undefined) values.metallicChannel = opts.metallicChannel;
  if (opts.roughnessChannel !== undefined) values.roughnessChannel = opts.roughnessChannel;
  if (opts.clearcoat !== undefined) values.clearcoat = opts.clearcoat;
  if (opts.clearcoatRoughness !== undefined) values.clearcoatRoughness = opts.clearcoatRoughness;
  if (opts.clearcoatTexture !== undefined) values.clearcoatTexture = opts.clearcoatTexture;
  if (opts.clearcoatRoughnessTexture !== undefined) {
    values.clearcoatRoughnessTexture = opts.clearcoatRoughnessTexture;
  }
  if (opts.clearcoatNormalTexture !== undefined) {
    values.clearcoatNormalTexture = opts.clearcoatNormalTexture;
  }
  if (opts.clearcoatNormalScale !== undefined)
    values.clearcoatNormalScale = opts.clearcoatNormalScale;
  if (opts.anisotropyStrength !== undefined) values.anisotropyStrength = opts.anisotropyStrength;
  if (opts.anisotropyRotation !== undefined) values.anisotropyRotation = opts.anisotropyRotation;
  if (opts.anisotropyTexture !== undefined) values.anisotropyTexture = opts.anisotropyTexture;
  if (opts.sheenColor !== undefined) values.sheenColor = linearColorFromInput(opts.sheenColor, 3);
  if (opts.sheenRoughness !== undefined) values.sheenRoughness = opts.sheenRoughness;
  if (opts.sheenColorTexture !== undefined) values.sheenColorTexture = opts.sheenColorTexture;
  if (opts.sheenRoughnessTexture !== undefined) {
    values.sheenRoughnessTexture = opts.sheenRoughnessTexture;
  }
  if (opts.diffuseTransmission !== undefined) {
    values.diffuseTransmission = opts.diffuseTransmission;
  }
  if (opts.diffuseTransmissionColor !== undefined) {
    values.diffuseTransmissionColor = linearColorFromInput(opts.diffuseTransmissionColor, 3);
  }
  if (opts.diffuseTransmissionTexture !== undefined) {
    values.diffuseTransmissionTexture = opts.diffuseTransmissionTexture;
  }
  if (opts.diffuseTransmissionColorTexture !== undefined) {
    values.diffuseTransmissionColorTexture = opts.diffuseTransmissionColorTexture;
  }
  if (opts.iridescence !== undefined) values.iridescence = opts.iridescence;
  if (opts.iridescenceIor !== undefined) values.iridescenceIor = opts.iridescenceIor;
  if (opts.iridescenceThicknessMinimum !== undefined) {
    values.iridescenceThicknessMinimum = opts.iridescenceThicknessMinimum;
  }
  if (opts.iridescenceThicknessMaximum !== undefined) {
    values.iridescenceThicknessMaximum = opts.iridescenceThicknessMaximum;
  }
  if (opts.iridescenceTexture !== undefined) values.iridescenceTexture = opts.iridescenceTexture;
  if (opts.iridescenceThicknessTexture !== undefined) {
    values.iridescenceThicknessTexture = opts.iridescenceThicknessTexture;
  }
  if (opts.emissive !== undefined) values.emissive = linearColorFromInput(opts.emissive, 3);
  if (opts.emissiveIntensity !== undefined) values.emissiveIntensity = opts.emissiveIntensity;
  if (opts.emissiveTexture !== undefined) values.emissiveTexture = opts.emissiveTexture;
  if (opts.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts.metallicRoughnessTexture !== undefined) {
    values.metallicRoughnessTexture = opts.metallicRoughnessTexture;
  }
  if (opts.metallicTexture !== undefined) values.metallicTexture = opts.metallicTexture;
  if (opts.roughnessTexture !== undefined) values.roughnessTexture = opts.roughnessTexture;
  if (opts.alphaTexture !== undefined) values.alphaTexture = opts.alphaTexture;
  if (opts.alphaChannel !== undefined) values.alphaChannel = opts.alphaChannel;
  if (opts.normalTexture !== undefined) values.normalTexture = opts.normalTexture;
  if (opts.normalScale !== undefined) values.normalScale = [...opts.normalScale];
  if (opts.bumpTexture !== undefined) values.bumpTexture = opts.bumpTexture;
  if (opts.bumpScale !== undefined) values.bumpScale = opts.bumpScale;
  if (opts.displacementTexture !== undefined) values.displacementTexture = opts.displacementTexture;
  if (opts.occlusionTexture !== undefined) values.occlusionTexture = opts.occlusionTexture;
  if (opts.specularTexture !== undefined) values.specularTexture = opts.specularTexture;
  if (opts.specularColorTexture !== undefined) {
    values.specularColorTexture = opts.specularColorTexture;
  }
  if (opts.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  if (opts.alphaHash !== undefined) values.alphaHash = Number(opts.alphaHash);
  if (opts.transmissionTexture !== undefined) values.transmissionTexture = opts.transmissionTexture;
  if (opts.thicknessTexture !== undefined) values.thicknessTexture = opts.thicknessTexture;
  if (opts.attenuationDistance !== undefined) values.attenuationDistance = opts.attenuationDistance;
  const forwardRenderState =
    transmission > 0 ? { ...(opts.renderState ?? {}), depthWriteEnabled: false } : opts.renderState;
  const parameters = standardSurfaceParameters(standardParameters('linear', opts));
  const declaredNames = new Set(parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(values)) {
    if (!declaredNames.has(name)) delete values[name];
  }
  const layerPlan = deriveStandardLayerPlan(parameters);
  const projected = projectStandardSurfacePasses({
    surfaceModule: DEFAULT_STANDARD_SURFACE_MODULE,
    values,
    ...(forwardRenderState === undefined ? {} : { renderState: forwardRenderState }),
    ...(opts.queue === undefined ? {} : { queue: opts.queue }),
    layerPlan,
  });
  const passes = (
    transmission > 0 ? projected.filter((entry) => entry.name !== 'deferred') : projected
  ) as [MaterialPass, ...MaterialPass[]];
  return {
    kind: 'material',
    colorSpace: 'linear',
    passes,
    parameters,
    values,
  };
}

function standardCustom(opts: CustomStandardSurfaceOptions): MaterialAsset {
  const layerPlan = deriveStandardLayerPlan(
    opts.parameters.filter((parameter) => parameter.optional !== true),
  );
  return {
    kind: 'material',
    ...(opts.colorSpace === undefined || opts.colorSpace === 'srgb'
      ? {}
      : { colorSpace: opts.colorSpace }),
    passes: projectStandardSurfacePasses({
      surfaceModule: opts.surfaceModule,
      values: opts.values,
      ...(opts.renderState === undefined ? {} : { renderState: opts.renderState }),
      ...(opts.queue === undefined ? {} : { queue: opts.queue }),
      layerPlan,
    }),
    parameters: standardSurfaceParameters(opts.parameters),
    values: opts.values,
  };
}

export function standard(options: StandardOptions): MaterialAsset {
  return options.surfaceModule === undefined ? standardDefault(options) : standardCustom(options);
}

export const Materials = { unlit, standard, srgb } as const;

export { SPRITE_MODULE };
