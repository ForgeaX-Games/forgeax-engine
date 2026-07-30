import { err, ok, type Result } from '@forgeax/engine-types';
import type { CompileResult } from '../index.js';

export interface MaterialComposeRequest {
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly imports?: Readonly<Record<string, string>>;
  readonly defines?: Readonly<Record<string, boolean>>;
}

export interface MaterialComposedSource {
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export interface ComposedMaterial {
  readonly material: string;
  readonly pass: string;
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export type MaterialComposeCompiler = (
  request: MaterialComposeRequest,
) => Promise<MaterialComposedSource | CompileResult>;

function isCompileResult(value: MaterialComposedSource | CompileResult): value is CompileResult {
  return 'manifestEntry' in value;
}

export async function composeMaterial(
  request: MaterialComposeRequest,
  compiler?: MaterialComposeCompiler,
): Promise<Result<ComposedMaterial, unknown>> {
  const compile =
    compiler ??
    (async (input) => {
      const { compileShader } = await import('../index.js');
      const options = {
        id: `${input.material}::${input.pass}`,
        ...(input.imports === undefined ? {} : { imports: { ...input.imports } }),
        ...(input.defines === undefined ? {} : { defines: { ...input.defines } }),
      };
      const result = await compileShader(input.source, options);
      if (!result.ok) return result as never;
      return result.value;
    });
  const result = await compile(request);
  if (!result || typeof result !== 'object') return err(result);
  if (isCompileResult(result)) {
    return ok({
      material: request.material,
      pass: request.pass,
      wgsl: result.wgsl,
      bindings: result.bindings,
      deps: result.deps,
      vertexInputs: [],
    });
  }
  return ok({
    material: request.material,
    pass: request.pass,
    wgsl: result.wgsl,
    bindings: result.bindings,
    deps: result.deps,
    vertexInputs: result.vertexInputs,
  });
}
