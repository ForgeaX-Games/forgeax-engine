// @forgeax/engine-shader-compiler/errors — re-export shim over @forgeax/engine-naga.
//
// feat-20260511-naga-rhi-wgpu-merge (plan-strategy D-P4) moved the ShaderError
// class + 4 factory helpers + Result<T, E> + wrapShaderError adapter down into
// @forgeax/engine-naga (which is now the upstream owner of the wasm boundary). This
// file is a pure re-export to keep @forgeax/engine-shader-compiler's public surface
// stable for AI users (charter proposition 5 consistent abstraction:
// `import { compileFailed, err, ok, ShaderError, ... } from '@forgeax/engine-shader-compiler'`
// continues to work byte-for-byte).
//
// The closed ShaderErrorCode 4-member union remains imported from
// @forgeax/engine-types (the SSOT): +0 breaking points to the error model (AC-09).

export {
  compileFailed,
  err,
  initFailed,
  manifestMalformed,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from '@forgeax/engine-naga';

import {
  createMaterialError,
  type MaterialErrorFor,
  type Result as MaterialResult,
  err as materialErr,
} from '@forgeax/engine-types';

export interface MaterialReflectionSourceSpan {
  readonly line: number;
  readonly column: number;
}

export interface MaterialReflectionBindingMismatchDetail {
  readonly code: 'material-reflection-binding-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly parameter: string;
  readonly expected: string;
  readonly actual: string;
  readonly sourceSpan: MaterialReflectionSourceSpan;
  readonly context: string;
}

export type MaterialReflectionError = Omit<
  MaterialErrorFor<'material-reflection-binding-mismatch'>,
  'detail'
> & { readonly detail: MaterialReflectionBindingMismatchDetail };

export function materialReflectionMismatch(
  detail: MaterialReflectionBindingMismatchDetail,
): MaterialReflectionError {
  const base = createMaterialError('material-reflection-binding-mismatch', {
    code: detail.code,
    material: detail.material,
    pass: detail.pass,
    parameter: detail.parameter,
    expected: detail.expected,
    actual: detail.actual,
  });
  return { ...base, detail };
}

export { type MaterialResult, materialErr };
