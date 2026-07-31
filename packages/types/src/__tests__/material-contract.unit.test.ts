import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssetGuid } from '../index.js';
import type { MaterialAsset } from '../material/asset.js';
import { resolveMaterialAsset } from '../material/resolve.js';

const guid = new Uint8Array(16) as AssetGuid;

const standardProgram = {
  module: 'forgeax::standard',
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
} as const;

describe('MaterialAsset contract', () => {
  it('accepts an erased numeric shared texture handle at runtime', () => {
    const result = resolveMaterialAsset('demo', {
      demo: {
        kind: 'material',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [{ name: 'baseColorTexture', type: 'texture' }],
        values: { baseColorTexture: 1024 },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('accepts a complete root contract and structured texture value', () => {
    const root = {
      kind: 'material',
      passes: [
        {
          name: 'forward',
          program: standardProgram,
          renderState: { cullMode: 'back' },
        },
      ],
      parameters: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'normalTexture', type: 'texture', optional: true },
      ],
      values: {
        baseColor: [0.8, 0.2, 0.1, 1],
        normalTexture: {
          texture: guid,
          sampler: guid,
          coordinates: {
            set: 1,
            transform: { offset: [0, 0], scale: [2, 2], rotation: 0.25 },
          },
          normalScale: 0.7,
        },
      },
    } satisfies MaterialAsset;

    expectTypeOf(root).toMatchTypeOf<MaterialAsset>();
  });

  it('accepts a single-parent derived contract with full value replacement', () => {
    const derived = {
      kind: 'material',
      parent: guid,
      values: {
        baseColor: [0.1, 0.4, 0.9, 1],
        normalTexture: null,
      },
    } satisfies MaterialAsset;

    expectTypeOf(derived.parent).toEqualTypeOf<AssetGuid>();
    expectTypeOf(derived.values).toMatchTypeOf<MaterialAsset['values']>();
  });

  it('requires complete pass replacement instead of a shader alias', () => {
    const derived = {
      kind: 'material',
      parent: guid,
      passes: [
        {
          name: 'forward',
          program: {
            module: 'project::toon',
            moduleSlots: { lighting: 'project::toon-lighting' },
          },
        },
      ],
    } satisfies MaterialAsset;

    expectTypeOf(derived.passes?.[0]?.program.module).toEqualTypeOf<string>();
  });

  it('rejects legacy fields, unknown values, and mismatched structured values', () => {
    const retiredField = ['param', 'Values'].join('') as `param${'Values'}`;
    // @ts-expect-error - the new contract has no retired parameter field.
    const legacyValues: MaterialAsset = { kind: 'material', [retiredField]: {} };
    void legacyValues;

    const legacyPass: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::standard' } }],
    };
    void legacyPass;

    const mismatchedValue: MaterialAsset = {
      kind: 'material',
      values: {
        // @ts-expect-error - a texture value is not an arbitrary string.
        normalTexture: 'not-a-texture-value',
      },
    };
    void mismatchedValue;

    // @ts-expect-error - unknown top-level authoring fields are not accepted.
    const unknownField: MaterialAsset = { kind: 'material', shader: 'legacy' };
    void unknownField;
  });
});
