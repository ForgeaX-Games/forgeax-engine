import type { MaterialAsset, MaterialError, MaterialValue } from '@forgeax/engine-types';
import { createMaterialError, err, ok, type Result } from '@forgeax/engine-types';
import type { MaterialVariantContext } from './variant-context.js';

export interface MaterialProjectionContext {
  readonly material: string;
  readonly mode: 'development' | 'production';
  readonly cooked?: boolean;
  readonly sourceClosure?: Readonly<Record<string, string>>;
  readonly vertexInputs?: readonly Readonly<Record<string, unknown>>[];
  readonly variantContext?: MaterialVariantContext;
}

export interface MaterialStaticSelection {
  readonly moduleSlots: Readonly<Record<string, string>>;
  readonly pipelineState: Readonly<Record<string, unknown>>;
  readonly sourceClosure: Readonly<Record<string, string>>;
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  readonly variantContext?: MaterialVariantContext;
}

export interface MaterialProjection {
  readonly runtimeValues: Readonly<Record<string, MaterialValue>>;
  readonly staticSelection: MaterialStaticSelection;
}

function staticNames(selection: MaterialStaticSelection): readonly string[] {
  return [
    ...Object.keys(selection.moduleSlots).map((name) => `module-slot:${name}`),
    'pipeline-state',
    'source-closure',
    'vertex-inputs',
  ];
}

export function projectMaterial(
  material: MaterialAsset,
  context: MaterialProjectionContext,
): Result<MaterialProjection, MaterialError> {
  const values = material.values ?? {};
  const runtimeValues: Record<string, MaterialValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue;
    runtimeValues[name] = value;
  }
  const moduleSlots: Record<string, string> = {};
  const pipelineState: Record<string, unknown> = {};
  for (const pass of material.passes ?? []) {
    for (const [name, module] of Object.entries(pass.program.moduleSlots ?? {}))
      moduleSlots[name] = module;
    Object.assign(pipelineState, pass.renderState ?? {});
  }
  const staticSelection: MaterialStaticSelection = {
    moduleSlots,
    pipelineState,
    sourceClosure: context.sourceClosure ?? {},
    vertexInputs: context.vertexInputs ?? [],
    ...(context.variantContext === undefined ? {} : { variantContext: context.variantContext }),
  };
  if (context.mode === 'production' && context.cooked !== true) {
    return err(
      createMaterialError('material-specialization-not-cooked', {
        code: 'material-specialization-not-cooked',
        material: context.material,
        staticSelection: staticNames(staticSelection),
      }),
    );
  }
  return ok({ runtimeValues, staticSelection });
}
