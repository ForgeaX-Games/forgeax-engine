// @forgeax/engine-assets-runtime -- material-validation free-function coverage
// (fix issue #709). validateMaterialPasses / validateSpriteSlices /
// validateParamType / detectTileNeedsRepeatSampler / materialShaderTextureFieldNames.
//
// The free functions read only `registry.shaderRegistry` / `.metrics` /
// `.assetCatalog`, so a duck-typed stub standing in for AssetRegistry suffices
// (charter F2: test against the surface the code touches, not the whole class).

import type { MaterialAsset, ParamSchemaEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { AssetRegistry } from '../asset-registry';
import {
  detectTileNeedsRepeatSampler,
  materialShaderTextureFieldNames,
  validateMaterialPasses,
  validateParamType,
  validateSpriteSlices,
} from '../registry/validate-material';

interface StubShaders {
  [shaderId: string]: readonly ParamSchemaEntry[];
}

function makeRegistry(
  shaders: StubShaders,
  opts: { metrics?: { increment(k: string): void }; catalog?: Map<string, unknown> } = {},
): AssetRegistry {
  return {
    shaderRegistry: {
      lookupMaterialShader(id: string) {
        const paramSchema = shaders[id];
        return paramSchema
          ? { ok: true as const, value: { source: '', paramSchema } }
          : { ok: false as const, error: new Error('not found') };
      },
    },
    metrics: opts.metrics ?? null,
    assetCatalog: opts.catalog ?? new Map(),
  } as unknown as AssetRegistry;
}

function mat(over: Partial<MaterialAsset>): MaterialAsset {
  return { kind: 'material', ...over } as MaterialAsset;
}

describe('validateMaterialPasses', () => {
  it('returns null when passes is undefined (inherits from parent)', () => {
    expect(validateMaterialPasses(makeRegistry({}), mat({}))).toBeNull();
  });

  it('errors when passes is an explicit empty array', () => {
    const e = validateMaterialPasses(makeRegistry({}), mat({ passes: [] }));
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { passCount: number }).passCount).toBe(0);
  });

  it('errors when a pass references an unregistered shader', () => {
    const e = validateMaterialPasses(
      makeRegistry({}),
      mat({ passes: [{ name: 'main', shader: 'forgeax::nope' }] }),
    );
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { cause: string }).cause).toBe('shader-not-found');
  });

  it('errors when a required (no-default) param is missing from paramValues', () => {
    const reg = makeRegistry({ 'forgeax::x': [{ name: 'roughness', type: 'f32' }] });
    const e = validateMaterialPasses(reg, mat({ passes: [{ name: 'm', shader: 'forgeax::x' }] }));
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { missingParams: string[] }).missingParams).toContain('roughness');
  });

  it('accepts when a required param is supplied with the right type', () => {
    const reg = makeRegistry({ 'forgeax::x': [{ name: 'roughness', type: 'f32' }] });
    expect(
      validateMaterialPasses(
        reg,
        mat({ passes: [{ name: 'm', shader: 'forgeax::x' }], paramValues: { roughness: 0.5 } }),
      ),
    ).toBeNull();
  });

  it('errors on a supplied param with a mismatched type', () => {
    const reg = makeRegistry({ 'forgeax::x': [{ name: 'roughness', type: 'f32' }] });
    const e = validateMaterialPasses(
      reg,
      mat({ passes: [{ name: 'm', shader: 'forgeax::x' }], paramValues: { roughness: 'no' } }),
    );
    expect((e?.detail as { paramName: string }).paramName).toBe('roughness');
  });

  it('skips params that carry a default', () => {
    const reg = makeRegistry({ 'forgeax::x': [{ name: 'roughness', type: 'f32', default: 0.5 }] });
    expect(
      validateMaterialPasses(reg, mat({ passes: [{ name: 'm', shader: 'forgeax::x' }] })),
    ).toBeNull();
  });
});

describe('validateParamType', () => {
  const reg = makeRegistry({});
  it('numeric scalars', () => {
    expect(validateParamType(reg, 'x', 'f32', 1)).toBe(true);
    expect(validateParamType(reg, 'x', 'u32', 'no')).toBe(false);
  });
  it('vector arities', () => {
    expect(validateParamType(reg, 'x', 'vec2', [1, 2])).toBe(true);
    expect(validateParamType(reg, 'x', 'vec3', [1, 2])).toBe(false);
    expect(validateParamType(reg, 'x', 'vec4', [1, 2, 3, 4])).toBe(true);
  });
  it('color accepts length 3 or 4', () => {
    expect(validateParamType(reg, 'x', 'color', [1, 2, 3])).toBe(true);
    expect(validateParamType(reg, 'x', 'color', [1, 2, 3, 4])).toBe(true);
    expect(validateParamType(reg, 'x', 'color', [1, 2])).toBe(false);
  });
  it('texture/sampler are string GUIDs at register time', () => {
    expect(validateParamType(reg, 'x', 'texture2d', 'guid')).toBe(true);
    expect(validateParamType(reg, 'x', 'sampler', 123)).toBe(false);
  });
  it('unknown type -> false', () => {
    expect(validateParamType(reg, 'x', 'mat4', {})).toBe(false);
  });
});

describe('validateSpriteSlices', () => {
  const reg = makeRegistry({});
  const spritePass = { name: 'main', shader: 'forgeax::sprite' };

  it('returns null for non-sprite shaders', () => {
    expect(
      validateSpriteSlices(reg, mat({ passes: [{ name: 'm', shader: 'forgeax::standard' }] })),
    ).toBeNull();
  });

  it('returns null when slices is absent', () => {
    expect(validateSpriteSlices(reg, mat({ passes: [spritePass], paramValues: {} }))).toBeNull();
  });

  it('accepts a well-formed slices tuple', () => {
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [0.1, 0.1, 0.1, 0.1] } }),
      ),
    ).toBeNull();
  });

  it('rejects a non-array / wrong-length / non-number slices', () => {
    expect(
      validateSpriteSlices(reg, mat({ passes: [spritePass], paramValues: { slices: 'x' } }))?.code,
    ).toBe('asset-invalid-value');
    expect(
      validateSpriteSlices(reg, mat({ passes: [spritePass], paramValues: { slices: [0, 0, 0] } }))
        ?.code,
    ).toBe('asset-invalid-value');
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [0, 0, 0, 'x'] } }),
      )?.code,
    ).toBe('asset-invalid-value');
  });

  it('rejects NaN, Infinity, and negative components', () => {
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [Number.NaN, 0, 0, 0] } }),
      ),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [Number.POSITIVE_INFINITY, 0, 0, 0] } }),
      ),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [-0.1, 0, 0, 0] } }),
      ),
    ).not.toBeNull();
  });

  it('rejects X-axis / Y-axis overlap against region', () => {
    // default region z/w = 1; left+right = 1.2 >= 1
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [0.6, 0, 0.6, 0] } }),
      ),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(
        reg,
        mat({ passes: [spritePass], paramValues: { slices: [0, 0.6, 0, 0.6] } }),
      ),
    ).not.toBeNull();
  });
});

describe('detectTileNeedsRepeatSampler', () => {
  const spritePass = { name: 'main', shader: 'forgeax::sprite' };

  it('no-ops when metrics is null', () => {
    // makeRegistry defaults metrics to null; call must not throw.
    expect(() =>
      detectTileNeedsRepeatSampler(
        makeRegistry({}),
        mat({ passes: [spritePass], paramValues: { sliceMode: 1, sampler: 'g' } }),
      ),
    ).not.toThrow();
  });

  it('increments the metric when a tile sampler is not repeat/repeat', () => {
    const counts: string[] = [];
    const catalog = new Map<string, unknown>([
      [
        's-guid',
        {
          kind: 'sampler',
          payload: { kind: 'sampler', addressModeU: 'clamp', addressModeV: 'repeat' },
        },
      ],
    ]);
    const reg = makeRegistry({}, { metrics: { increment: (k) => counts.push(k) }, catalog });
    detectTileNeedsRepeatSampler(
      reg,
      mat({ passes: [spritePass], paramValues: { sliceMode: 1, sampler: 'S-GUID' } }),
    );
    expect(counts).toContain('nineslice.tile-needs-repeat-sampler');
  });

  it('does not increment when the sampler is repeat/repeat', () => {
    const counts: string[] = [];
    const catalog = new Map<string, unknown>([
      [
        's-guid',
        {
          kind: 'sampler',
          payload: { kind: 'sampler', addressModeU: 'repeat', addressModeV: 'repeat' },
        },
      ],
    ]);
    const reg = makeRegistry({}, { metrics: { increment: (k) => counts.push(k) }, catalog });
    detectTileNeedsRepeatSampler(
      reg,
      mat({ passes: [spritePass], paramValues: { sliceMode: 1, sampler: 's-guid' } }),
    );
    expect(counts).toEqual([]);
  });

  it('no-ops for sliceMode !== 1', () => {
    const counts: string[] = [];
    const reg = makeRegistry({}, { metrics: { increment: (k) => counts.push(k) } });
    detectTileNeedsRepeatSampler(reg, mat({ passes: [spritePass], paramValues: { sliceMode: 0 } }));
    expect(counts).toEqual([]);
  });
});

describe('materialShaderTextureFieldNames', () => {
  it('returns the texture field-name set derived from paramSchema', () => {
    const reg = makeRegistry({
      'forgeax::x': [
        { name: 'roughness', type: 'f32' },
        { name: 'baseColorTexture', type: 'texture2d' },
      ],
    });
    const names = materialShaderTextureFieldNames(reg, 'forgeax::x');
    expect(names).toBeDefined();
    expect(names?.has('baseColorTexture')).toBe(true);
    expect(names?.has('roughness')).toBe(false);
  });

  it('returns undefined for an unregistered shader', () => {
    expect(materialShaderTextureFieldNames(makeRegistry({}), 'forgeax::nope')).toBeUndefined();
  });
});
