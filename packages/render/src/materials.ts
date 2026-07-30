import type {
  MaterialAsset,
  MaterialParameter,
  MaterialPass,
  MaterialRenderState,
  MaterialValue,
} from '@forgeax/engine-types';

export const SPRITE_PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const STANDARD_MODULE = 'forgeax_material::standard';
const UNLIT_MODULE = 'forgeax_material::unlit';
const SPRITE_MODULE = 'forgeax_material::sprite';

const standardParameters: readonly MaterialParameter[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
  { name: 'metallicChannel', type: 'f32', optional: true },
  { name: 'roughnessChannel', type: 'f32', optional: true },
  { name: 'aoChannel', type: 'f32', optional: true },
  { name: 'extraChannel', type: 'f32', optional: true },
  { name: 'emissive', type: 'vec3', optional: true },
  { name: 'emissiveIntensity', type: 'f32', optional: true },
  { name: 'occlusionStrength', type: 'f32', optional: true },
  { name: 'alphaCutoff', type: 'f32', optional: true },
  { name: 'clearcoat', type: 'f32', optional: true },
  { name: 'clearcoatRoughness', type: 'f32', optional: true },
  { name: 'specularTint', type: 'vec3', optional: true },
  { name: 'baseColorTexture', type: 'texture', optional: true },
  { name: 'metallicRoughnessTexture', type: 'texture', optional: true },
  { name: 'normalTexture', type: 'texture', optional: true },
  { name: 'specularTintTexture', type: 'texture', optional: true },
  { name: 'emissiveTexture', type: 'texture', optional: true },
  { name: 'occlusionTexture', type: 'texture', optional: true },
];

const unlitParameters: readonly MaterialParameter[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'baseColorTexture', type: 'texture', optional: true },
  { name: 'alphaCutoff', type: 'f32', optional: true },
];

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
  readonly castShadow?: boolean;
  readonly baseColorTexture?: MaterialValue;
  readonly alphaCutoff?: number;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
}

function unlit(rgba: readonly [number, number, number, number], opts?: UnlitOpts): MaterialAsset {
  if (opts?.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new Error(`Materials.unlit: alphaCutoff must be in [0, 1], got ${opts.alphaCutoff}`);
  }
  const values: Record<string, MaterialValue> = { baseColor: rgba };
  if (opts?.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts?.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  const passes: [MaterialPass, ...MaterialPass[]] = [
    pass('forward', UNLIT_MODULE, opts?.renderState, undefined, opts?.queue),
  ];
  if (opts?.castShadow !== false) passes.push(pass('shadow-caster', UNLIT_MODULE, undefined));
  return {
    kind: 'material',
    passes,
    parameters: unlitParameters,
    values,
  };
}

interface StandardOpts {
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  readonly specularTint?: readonly [number, number, number];
  readonly specularTintTexture?: MaterialValue;
  readonly emissive?: readonly [number, number, number];
  readonly emissiveIntensity?: number;
  readonly emissiveTexture?: MaterialValue;
  readonly baseColorTexture?: MaterialValue;
  readonly metallicRoughnessTexture?: MaterialValue;
  readonly normalTexture?: MaterialValue;
  readonly occlusionTexture?: MaterialValue;
  readonly occlusionStrength?: number;
  readonly alphaCutoff?: number;
  readonly renderState?: MaterialRenderState;
  readonly castShadow?: boolean;
  readonly queue?: number;
}

function standard(opts: StandardOpts): MaterialAsset {
  const occlusionStrength = opts.occlusionStrength ?? 1;
  if (occlusionStrength < 0 || occlusionStrength > 1) {
    throw new Error(
      `Materials.standard: occlusionStrength must be in [0, 1], got ${occlusionStrength}`,
    );
  }
  if (opts.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new Error(`Materials.standard: alphaCutoff must be in [0, 1], got ${opts.alphaCutoff}`);
  }
  const values: Record<string, MaterialValue> = {
    baseColor: opts.baseColor,
    metallic: opts.metallic ?? 0,
    roughness: opts.roughness ?? 0.5,
    occlusionStrength,
    specularTint: opts.specularTint ?? [1, 1, 1],
  };
  if (opts.clearcoat !== undefined) values.clearcoat = opts.clearcoat;
  if (opts.clearcoatRoughness !== undefined) values.clearcoatRoughness = opts.clearcoatRoughness;
  if (opts.emissive !== undefined) values.emissive = opts.emissive;
  if (opts.emissiveIntensity !== undefined) values.emissiveIntensity = opts.emissiveIntensity;
  if (opts.emissiveTexture !== undefined) values.emissiveTexture = opts.emissiveTexture;
  if (opts.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts.metallicRoughnessTexture !== undefined) {
    values.metallicRoughnessTexture = opts.metallicRoughnessTexture;
  }
  if (opts.normalTexture !== undefined) values.normalTexture = opts.normalTexture;
  if (opts.occlusionTexture !== undefined) values.occlusionTexture = opts.occlusionTexture;
  if (opts.specularTintTexture !== undefined) {
    values.specularTintTexture = opts.specularTintTexture;
  }
  if (opts.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  const passes: [MaterialPass, ...MaterialPass[]] = [
    pass('forward', STANDARD_MODULE, opts.renderState, 'fs_main', opts.queue),
    pass('deferred', STANDARD_MODULE, opts.renderState, 'fs_gbuffer', opts.queue),
  ];
  if (opts.castShadow !== false) passes.push(pass('shadow-caster', STANDARD_MODULE, undefined));
  return {
    kind: 'material',
    passes,
    parameters: standardParameters,
    values,
  };
}

export const Materials = { unlit, standard } as const;

export { SPRITE_MODULE };
