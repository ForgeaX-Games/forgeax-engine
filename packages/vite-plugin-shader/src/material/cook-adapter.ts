import type { Result, ShaderError } from '@forgeax/engine-shader-compiler';
import {
  type CompileOptions,
  type CompileResult,
  compileShader,
} from '@forgeax/engine-shader-compiler';

export type MaterialCookResult = Result<CompileResult, ShaderError>;

export function cookMaterialSource(
  source: string,
  options: CompileOptions,
): Promise<MaterialCookResult> {
  return compileShader(source, options);
}
