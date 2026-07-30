import type {
  MaterialAsset,
  MaterialError,
  MaterialTextureValue,
  MaterialValue,
} from '@forgeax/engine-types';
import { createMaterialError, err, ok, type Result } from '@forgeax/engine-types';

export interface MaterialProjectionContext {
  readonly material: string;
  readonly mode: 'development' | 'production';
  readonly cooked?: boolean;
  readonly defines?: Readonly<Record<string, boolean | number | undefined>>;
  readonly sourceClosure?: Readonly<Record<string, string>>;
  readonly vertexInputs?: readonly Readonly<Record<string, unknown>>[];
}

export interface MaterialStaticSelection {
  readonly values: Readonly<Record<string, MaterialValue>>;
  readonly texturePresence: Readonly<Record<string, boolean>>;
  readonly textureInputs: Readonly<Record<string, MaterialTextureValue>>;
  readonly defines: Readonly<Record<string, boolean | number | undefined>>;
  readonly moduleSlots: Readonly<Record<string, string>>;
  readonly pipelineState: Readonly<Record<string, unknown>>;
  readonly sourceClosure: Readonly<Record<string, string>>;
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export interface MaterialProjection {
  readonly runtimeValues: Readonly<Record<string, MaterialValue>>;
  readonly staticSelection: MaterialStaticSelection;
}

function staticNames(selection: MaterialStaticSelection): readonly string[] {
  return [
    ...Object.keys(selection.values),
    ...Object.keys(selection.texturePresence),
    ...Object.keys(selection.defines).map((name) => `define:${name}`),
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
  const declarations = new Map(
    (material.parameters ?? []).map((parameter) => [parameter.name, parameter]),
  );
  const runtimeValues: Record<string, MaterialValue> = {};
  const staticValues: Record<string, MaterialValue> = {};
  const texturePresence: Record<string, boolean> = {};
  const textureInputs: Record<string, MaterialTextureValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue;
    const parameter = declarations.get(name);
    if (parameter?.static === true) staticValues[name] = value;
    else runtimeValues[name] = value;
    if (parameter?.type === 'texture' && typeof value === 'object' && !Array.isArray(value)) {
      texturePresence[name] = true;
      if (parameter.static === true) textureInputs[name] = value as MaterialTextureValue;
    }
  }
  const moduleSlots: Record<string, string> = {};
  const pipelineState: Record<string, unknown> = {};
  for (const pass of material.passes ?? []) {
    for (const [name, module] of Object.entries(pass.program.moduleSlots ?? {}))
      moduleSlots[name] = module;
    Object.assign(pipelineState, pass.renderState ?? {});
  }
  const staticSelection: MaterialStaticSelection = {
    values: staticValues,
    texturePresence,
    textureInputs,
    defines: context.defines ?? {},
    moduleSlots,
    pipelineState,
    sourceClosure: context.sourceClosure ?? {},
    vertexInputs: context.vertexInputs ?? [],
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
