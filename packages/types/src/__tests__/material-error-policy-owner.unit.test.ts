import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createMaterialError,
  MATERIAL_ERROR_CODES,
  MATERIAL_ERROR_EXPECTED,
  MATERIAL_ERROR_HINTS,
  type MaterialError,
  type MaterialErrorCode,
  type MaterialErrorFor,
} from '../material/errors.js';

const expectedCodes = [
  'material-parent-not-found',
  'material-circular-inheritance',
  'material-no-effective-pass',
  'material-value-unknown',
  'material-value-type-mismatch',
  'material-contract-program-mismatch',
  'shader-module-id-missing',
  'shader-module-id-duplicate',
  'shader-module-not-found',
  'shader-module-namespace-reserved',
  'material-reflection-binding-mismatch',
  'material-specialization-not-cooked',
  'material-specialization-stale-generation',
  'gltf-material-uv-set-missing',
] as const;

const expectedPolicy = {
  'material-parent-not-found': {
    expected: 'every parent GUID resolves to a MaterialAsset',
    hint: 'fix the parent GUID and resolve the material again',
  },
  'material-circular-inheritance': {
    expected: 'the parent chain is acyclic',
    hint: 'remove the repeated GUID from the parent chain',
  },
  'material-no-effective-pass': {
    expected: 'the resolved material has at least one pass',
    hint: 'add a pass to the root material or an inherited parent',
  },
  'material-value-unknown': {
    expected: 'every value name is declared by the effective contract',
    hint: 'remove the value or declare the parameter in the root contract',
  },
  'material-value-type-mismatch': {
    expected: 'each value matches its declared parameter type',
    hint: 'change the value to the declared parameter type',
  },
  'material-contract-program-mismatch': {
    expected: 'the program satisfies the material contract',
    hint: 'align the program entries with the root contract',
  },
  'shader-module-id-missing': {
    expected: 'each WGSL source declares a module ID',
    hint: 'add a compiler-native module ID declaration to the WGSL source',
  },
  'shader-module-id-duplicate': {
    expected: 'each module ID has one source provenance',
    hint: 'rename one module or remove the duplicate source',
  },
  'shader-module-not-found': {
    expected: 'every referenced module exists in the source catalog',
    hint: 'add the module to the source catalog or fix the reference',
  },
  'shader-module-namespace-reserved': {
    expected: 'user modules use a non-reserved namespace',
    hint: 'choose a module ID outside the reserved namespace',
  },
  'material-reflection-binding-mismatch': {
    expected: 'reflection matches the material contract bindings',
    hint: 'update the contract or WGSL binding and cook again',
  },
  'material-specialization-not-cooked': {
    expected: 'the requested specialization has a cooked artifact',
    hint: 'run the build or development cook path for this selection',
  },
  'material-specialization-stale-generation': {
    expected: 'all specialization dependencies share one generation',
    hint: 'retry after dependent assets and sources settle',
  },
  'gltf-material-uv-set-missing': {
    expected: 'each texture slot references an available primitive UV set',
    hint: 'add the requested UV set to the primitive and re-import it',
  },
} satisfies Record<MaterialErrorCode, { expected: string; hint: string }>;

describe('MaterialError policy ownership', () => {
  it('preserves the exact fourteen-code tuple and its public type', () => {
    expect(MATERIAL_ERROR_CODES).toEqual(expectedCodes);
    expectTypeOf<typeof MATERIAL_ERROR_CODES>().toEqualTypeOf<typeof expectedCodes>();
    expectTypeOf<MaterialErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
  });

  it('derives both public projections with byte-identical values and key order', () => {
    expect(Object.keys(MATERIAL_ERROR_EXPECTED)).toEqual(expectedCodes);
    expect(Object.keys(MATERIAL_ERROR_HINTS)).toEqual(expectedCodes);

    for (const code of expectedCodes) {
      expect(MATERIAL_ERROR_EXPECTED[code]).toBe(expectedPolicy[code].expected);
      expect(MATERIAL_ERROR_HINTS[code]).toBe(expectedPolicy[code].hint);
    }
  });

  it('keeps projection types and ordinary object enumerability unchanged', () => {
    expectTypeOf<typeof MATERIAL_ERROR_EXPECTED>().toEqualTypeOf<
      Readonly<Record<MaterialErrorCode, string>>
    >();
    expectTypeOf<typeof MATERIAL_ERROR_HINTS>().toEqualTypeOf<
      Readonly<Record<MaterialErrorCode, string>>
    >();

    for (const projection of [MATERIAL_ERROR_EXPECTED, MATERIAL_ERROR_HINTS]) {
      for (const code of expectedCodes) {
        expect(Object.getOwnPropertyDescriptor(projection, code)).toMatchObject({
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('preserves correlated factory output and default/explicit messages', () => {
    const detail = {
      code: 'material-value-type-mismatch',
      material: 'demo',
      parameter: 'baseColor',
      expectedType: 'color',
      actualType: 'texture',
    } as const;
    const defaultMessage = createMaterialError('material-value-type-mismatch', detail);
    const explicitMessage = createMaterialError(
      'material-value-type-mismatch',
      detail,
      'custom diagnostic',
    );

    expectTypeOf(defaultMessage).toEqualTypeOf<MaterialErrorFor<'material-value-type-mismatch'>>();
    expectTypeOf<MaterialError>().toMatchTypeOf<MaterialErrorFor<MaterialErrorCode>>();
    expect(defaultMessage).toEqual({
      code: 'material-value-type-mismatch',
      expected: expectedPolicy['material-value-type-mismatch'].expected,
      hint: expectedPolicy['material-value-type-mismatch'].hint,
      detail,
      message: 'material-value-type-mismatch: each value matches its declared parameter type',
    });
    expect(explicitMessage.message).toBe('custom diagnostic');
    expect(Object.keys(defaultMessage)).toEqual(['code', 'expected', 'hint', 'detail', 'message']);
  });
});
