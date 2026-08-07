import { describe, expectTypeOf, it } from 'vitest';
import type {
  MATERIAL_ERROR_CODES,
  MaterialError,
  MaterialErrorCode,
  MaterialErrorDetail,
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

declare const error: MaterialError;

function renderDiagnostic(error: MaterialError): string {
  switch (error.code) {
    case 'material-parent-not-found':
      return error.detail.missingParent;
    case 'material-circular-inheritance':
      return error.detail.chain.join(' -> ');
    case 'material-no-effective-pass':
      return error.detail.material;
    case 'material-value-unknown':
      return error.detail.parameter;
    case 'material-value-type-mismatch':
      return `${error.detail.parameter}:${error.detail.expectedType}`;
    case 'material-contract-program-mismatch':
      return `${error.detail.pass}:${error.detail.program}`;
    case 'shader-module-id-missing':
      return error.detail.source;
    case 'shader-module-id-duplicate':
      return error.detail.module;
    case 'shader-module-not-found':
      return error.detail.module;
    case 'shader-module-namespace-reserved':
      return error.detail.module;
    case 'material-reflection-binding-mismatch':
      return error.detail.parameter;
    case 'material-specialization-not-cooked':
      return error.detail.material;
    case 'material-specialization-stale-generation':
      return error.detail.material;
    case 'gltf-material-uv-set-missing':
      return `${error.detail.material}:${error.detail.slot}`;
  }
}

describe('MaterialError closed contract', () => {
  it('projects the complete detail family from the material error union', () => {
    expectTypeOf<MaterialErrorDetail>().toEqualTypeOf<MaterialError['detail']>();
  });

  it('keeps the planned error code set closed and discoverable', () => {
    expectTypeOf<typeof MATERIAL_ERROR_CODES>().toEqualTypeOf<typeof expectedCodes>();
    expectTypeOf<MaterialErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
  });

  it('narrows detail by code without reading message text', () => {
    const diagnostic = renderDiagnostic(error);

    expectTypeOf(diagnostic).toBeString();
    expectTypeOf<MaterialError['expected']>().toBeString();
    expectTypeOf<MaterialError['hint']>().toBeString();
    expectTypeOf<MaterialError['code']>().toBeString();
  });
});
