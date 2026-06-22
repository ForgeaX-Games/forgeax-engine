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
