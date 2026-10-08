import type { CookedMaterialRecord, MaterialCookProgramContext } from '@forgeax/engine-pack';
import { materialProgramContextKey } from '@forgeax/engine-pack/material-cook';
import {
  type MaterialArtifactConflictError,
  MaterialArtifactRegistry,
  type MaterialRuntimeArtifact,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import type {
  MaterialParameter,
  MaterialProgramAbi,
  MaterialProgramAddress,
  MaterialSurfaceDeclaration,
  MaterialValue,
  ParamSchemaEntry,
} from '@forgeax/engine-types';
import { projectMaterialParameterSchema } from '@forgeax/engine-types';
import type { MaterialLoadError, MaterialReady } from './loader';

export interface MaterialRenderPassProjection {
  readonly name: string;
  readonly module: string;
  readonly outputs?: import('@forgeax/engine-types').MaterialPass['outputs'];
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
  readonly programs: readonly {
    readonly context: MaterialCookProgramContext;
    readonly specializationKey: string;
    readonly artifactHash: string;
    readonly address?: MaterialProgramAddress;
    readonly entry?: string;
    readonly abi?: MaterialProgramAbi;
  }[];
}

export interface MaterialRenderProjection {
  readonly materialGuid: string;
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactHash: string;
  readonly passes: readonly MaterialRenderPassProjection[];
  readonly runtimeValues: Readonly<Record<string, MaterialValue | null>>;
  /** Root-published Surface model; Render owns preparation and admission. */
  readonly surface?: MaterialSurfaceDeclaration;
  readonly staticSelection: readonly string[];
}

/** Exact Pass/context lookup; the renderer supplies all domain-owned axes. */
export function selectMaterialPassProgram(
  projection: MaterialRenderProjection,
  passName: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress = 'direct',
  vertexColorAvailable = false,
): MaterialRenderPassProjection['programs'][number] {
  const key = materialProgramContextKey(context);
  const modernPublication = projection.passes.some((pass) =>
    pass.programs.some(
      (program) =>
        program.context.pipeline !== 'ray' &&
        (program.address !== undefined || program.entry !== undefined || program.abi !== undefined),
    ),
  );
  const candidates = projection.passes
    .filter((pass) => pass.name === passName)
    .flatMap((pass) =>
      pass.programs.filter(
        (program) =>
          materialProgramContextKey(program.context) === key &&
          (context.pipeline === 'ray'
            ? address === 'direct'
            : modernPublication
              ? program.address === address
              : (program.address ?? 'direct') === address),
      ),
    );
  // Extra mesh attributes need no shader input. Prefer the color variant when
  // published; shaders that do not consume color can still draw colored meshes.
  const hasColor = (program: MaterialRenderPassProjection['programs'][number]) =>
    program.abi?.vertexInputs.some((input) => input.semantic === 'color') === true;
  const selectColor = vertexColorAvailable && candidates.some(hasColor);
  const matches = candidates.filter((program) => hasColor(program) === selectColor);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw Object.assign(
      new Error(
        `Material ${projection.materialGuid} has no unique published program for ${passName} in ${key}`,
      ),
      {
        code: 'material-specialization-not-cooked',
        expected: 'exactly one program for the selected Pass and renderer context',
        hint: 'cook the required context before rendering this material',
        retryable: false,
        recoveryActions: ['recook-material-publication'],
        detail: {
          guid: projection.materialGuid,
          specializationKey: projection.specializationKey,
          pass: passName,
          context,
          address,
          vertexColorAvailable,
          matches: matches.length,
        },
      } satisfies MaterialLoadError['error'],
    );
  }
  return matches[0];
}

/** Project authored MaterialAsset parameters into the runtime shader schema. */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
  material = '<runtime>',
): readonly ParamSchemaEntry[] {
  const schema = projectMaterialParameterSchema(parameters, material, 'runtime');
  if (!schema.ok) throw Object.assign(new Error(schema.error.message), schema.error);
  return schema.value;
}

/** Project authored pass module ids onto the renderer's canonical ids. */
export function runtimeMaterialShaderId(
  module: string | undefined,
  passName?: string,
): string | undefined {
  if (
    passName === 'shadow-caster' &&
    (module === 'forgeax_material::standard' || module === 'forgeax::default-standard-pbr')
  ) {
    return 'forgeax::default-shadow-caster';
  }
  switch (module) {
    case 'forgeax_material::standard':
      return 'forgeax::default-standard-pbr';
    case 'forgeax_material::unlit':
      return 'forgeax::default-unlit';
    case 'forgeax_material::sprite':
      return 'forgeax::sprite';
    case 'forgeax_material::sprite-lit':
      return 'forgeax::sprite-lit';
    default:
      return module;
  }
}

export function projectMaterialRecord(record: CookedMaterialRecord): MaterialRenderProjection {
  return {
    materialGuid: record.materialGuid ?? record.guid,
    publicationGeneration: record.publicationGeneration ?? record.receipt.identity.cookGeneration,
    specializationKey: record.specializationKey ?? record.receipt.identity.artifactDigest,
    artifactHash: record.receipt.identity.artifactDigest,
    passes: record.resolved.passes.map((pass) => ({
      name: pass.name,
      module: pass.program.module,
      ...(pass.outputs === undefined ? {} : { outputs: pass.outputs }),
      ...(pass.program.vertexEntry === undefined ? {} : { vertexEntry: pass.program.vertexEntry }),
      ...(pass.program.fragmentEntry === undefined
        ? {}
        : { fragmentEntry: pass.program.fragmentEntry }),
      ...(pass.program.moduleSlots === undefined ? {} : { moduleSlots: pass.program.moduleSlots }),
      ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
      programs: record.programs.flatMap((program) =>
        program.selections
          .filter((selection) => selection.pass === pass.name)
          .map((selection) => ({
            context: selection.context,
            specializationKey: program.specializationKey,
            artifactHash: program.artifact.digest,
            ...(selection.address === undefined ? {} : { address: selection.address }),
            ...(selection.entry === undefined ? {} : { entry: selection.entry }),
            ...(selection.abi === undefined ? {} : { abi: selection.abi }),
          })),
      ),
    })),
    runtimeValues: record.resolved.values,
    ...(record.resolved.surface === undefined ? {} : { surface: record.resolved.surface }),
    staticSelection: [],
  };
}

function conflictError(error: MaterialArtifactConflictError): Error {
  return Object.assign(new Error(`${error.code}: ${error.detail.key}`), error);
}

/** Preflight the complete set before mutating either runtime registry. */
export function installMaterialReadyShaders(
  shaderRegistry: ShaderRegistry,
  readiness: MaterialReady,
  artifactRegistry: MaterialArtifactRegistry,
): MaterialRenderProjection {
  // Defaults belong to the root value contract, not an immutable shared program.
  const paramSchema = materialParametersToParamSchema(
    readiness.record.parameterContract.parameters,
    readiness.record.guid,
  ).map(({ default: _default, ...parameter }) => parameter);
  const entries = readiness.record.programs.map((program) => {
    const source = new TextDecoder().decode(program.artifact.bytes);
    if (source.length === 0)
      throw new Error(
        `MaterialReady ${readiness.record.guid} contains an empty shader program ${program.specializationKey}`,
      );
    const pass = readiness.record.resolved.passes.find((pass) =>
      program.selections.some((selection) => selection.pass === pass.name),
    );
    const abi = program.selections.find((selection) => selection.abi !== undefined)?.abi;
    const artifact: MaterialRuntimeArtifact = {
      key: program.specializationKey,
      bytes: new Uint8Array(program.artifact.bytes),
      digest: program.artifact.digest,
      metadata: Object.freeze({
        module: pass?.program.module,
        paramSchema,
        ...(abi === undefined ? {} : { abi, receipt: abi }),
      }),
    };
    return { artifact, source, ...(abi === undefined ? {} : { abi }) };
  });
  const validation = new MaterialArtifactRegistry();
  for (const { artifact, source, abi } of entries) {
    const previous = artifactRegistry.get(artifact.key);
    if (previous !== undefined) validation.register(previous).unwrap();
    const checked = validation.register(artifact);
    if (!checked.ok) throw conflictError(checked.error);
    const shader = shaderRegistry.findMaterialArtifact(artifact.key);
    if (
      shader.ok &&
      (shader.value.source !== source ||
        JSON.stringify(shader.value.paramSchema) !== JSON.stringify(paramSchema) ||
        JSON.stringify(shader.value.receipt) !== JSON.stringify(abi))
    ) {
      throw conflictError({
        code: 'material-artifact-conflict',
        expected: 'one immutable source, interface, and ABI receipt per program key',
        hint: 're-cook the conflicting program',
        detail: {
          key: artifact.key,
          dimension:
            shader.value.source !== source
              ? 'bytes'
              : JSON.stringify(shader.value.paramSchema) !== JSON.stringify(paramSchema)
                ? 'param-schema'
                : 'receipt',
        },
      });
    }
  }
  for (const { artifact, source, abi } of entries) {
    artifactRegistry.register(artifact).unwrap();
    if (!shaderRegistry.findMaterialArtifact(artifact.key).ok)
      shaderRegistry.installMaterialArtifact(artifact.key, {
        source,
        paramSchema,
        ...(abi === undefined ? {} : { receipt: abi }),
      });
  }
  return projectMaterialRecord(readiness.record);
}
