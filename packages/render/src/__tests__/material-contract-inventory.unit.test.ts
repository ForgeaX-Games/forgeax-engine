import {
  createBuiltinMaterialAsset,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials.js';
import { materialParametersToParamSchema } from '../render-system-extract.js';

describe('vertex color does not change the material contract', () => {
  it('keeps colored and plain materials on the same schema and resource identity', () => {
    const plain = createBuiltinMaterialAsset('standard');
    const colored = createBuiltinMaterialAsset('standard');
    expect(colored.parameters).toEqual(plain.parameters);
    expect(colored.passes).toEqual(plain.passes);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).toContain('baseColor');
    expect(DEFAULT_UNLIT_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
  });

  it('keeps vertex color out of the authored material flags and bindings', () => {
    const material = createBuiltinMaterialAsset('unlit');
    expect(JSON.stringify(material)).not.toMatch(/hasColor|VERTEX_COLOR_AVAILABLE|colorBinding/i);
    expect(material.passes?.[0]?.program).not.toHaveProperty('color');
  });

  it.each([
    ['unlit', Materials.unlit([0.5, 0.5, 0.5, 1])],
    ['standard', Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] })],
  ] as const)('keeps the %s factory fallback aligned with its color schema', (_name, material) => {
    const resolved = resolveMaterialAsset('factory-fallback', {
      'factory-fallback': material,
    });
    expect(resolved).toMatchObject({ ok: true });
  });

  it('keeps the standard authoring parameters derived from the shared schema', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    expect(
      material.parameters
        ?.filter((parameter) => parameter.type !== 'texture')
        .map((parameter) => parameter.name),
    ).toEqual([
      'alphaChannel',
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
      'specular',
      'alphaHash',
      'specularColor',
      'normalScale',
      'bumpScale',
      'ior',
      'displacementScale',
      'displacementBias',
      'triplanarSpace',
      'triplanarScale',
      'triplanarSharpness',
      'normalMapSpace',
    ]);
    expect(material.values).not.toHaveProperty('transmission');
    expect(material.values).toHaveProperty('ior', 1.5);
  });

  it('routes canonical Standard roots through the complete runtime UBO schema', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const authoredSchema = materialParametersToParamSchema(material.parameters ?? []);
    const canonicalSchema = materialParametersToParamSchema(
      material.parameters ?? [],
      'forgeax::default-standard-pbr',
    );

    expect(authoredSchema.map((entry) => entry.name)).toEqual(
      material.parameters?.map((parameter) => parameter.name),
    );
    expect(canonicalSchema).toBe(STANDARD_PIPELINE_PARAM_SCHEMA);
    expect(authoredSchema).not.toBe(STANDARD_PIPELINE_PARAM_SCHEMA);
  });

  it('publishes the complete Standard contract when authoring a custom Surface', () => {
    const custom = Materials.standard({
      surfaceModule: 'project::paint',
      parameters: [{ name: 'paintStrength', type: 'f32', default: 0.75 }],
      values: { paintStrength: 0.5 },
    });
    const names = custom.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        'baseColor',
        'metallic',
        'roughness',
        'normalScale',
        'bumpScale',
        'paintStrength',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(custom.parameters?.find((parameter) => parameter.name === 'paintStrength')).toEqual({
      name: 'paintStrength',
      type: 'f32',
      default: 0.75,
    });
    expect(custom.values).toEqual({ paintStrength: 0.5 });
    expect(names).not.toContain('clearcoat');
  });

  it('routes active transmission to Forward and ShadowCaster only', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], transmission: 0.5 });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.passes?.[0]?.renderState).toMatchObject({ depthWriteEnabled: false });
  });

  it('projects the standard material raster orientation into its ShadowCaster pass', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      renderState: { cullMode: 'none', frontFace: 'cw' },
    });
    const shadowCaster = material.passes?.find((entry) => entry.name === 'shadow-caster');
    expect(shadowCaster?.renderState).toMatchObject({ cullMode: 'none', frontFace: 'cw' });
  });

  it.each([
    ['transmission', { transmission: -0.1 }],
    ['ior', { ior: 0 }],
    ['thickness', { thickness: -0.1 }],
    ['attenuationDistance', { attenuationDistance: 0 }],
  ])('rejects invalid %s before material publication', (_name, options) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], ...options })).toThrow();
  });

  it('rejects BLEND and depth writes for an active transmission material', () => {
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 0.5,
        renderState: {
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 0.5,
        renderState: { depthWriteEnabled: true },
      }),
    ).toThrow();
  });
});
