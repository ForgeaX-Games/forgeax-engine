import {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  createMaterialCookIdentity,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  type MaterialCookReceipt,
  type MaterialCookWasmProvenance,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { RaySurfaceProgram } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { MaterialCookedPass } from './cook.js';
import { lowerMaterialVariantContext } from './variant-context.js';

const MATERIAL_COOK_PROFILE = 'webgpu/v1';
const MATERIAL_COOK_COMPILER_VERSION = 'forgeax-material-cooker/1';
export interface MaterialPublicationInput {
  readonly guid: string;
  readonly source: MaterialAsset;
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
  readonly sourceRevision?: string;
  readonly valueGeneration?: number;
  readonly dependencyGeneration?: number;
  readonly cookGeneration?: number;
  readonly profile?: string;
  readonly compilerVersion?: string;
}
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function materialPrograms(
  passes: readonly MaterialCookedPass[],
  input: MaterialPublicationInput,
): readonly MaterialCookProgram[] {
  const programs = new Map<string, MaterialCookProgram>();
  for (const pass of passes) {
    const variants = [
      { compile: pass.compile, address: pass.abi === undefined ? undefined : ('direct' as const) },
      ...(pass.sceneCompile === undefined || pass.abi === undefined
        ? []
        : [{ compile: pass.sceneCompile, address: 'scene-index' as const }]),
    ];
    for (const variant of variants) {
      const bytes = new TextEncoder().encode(variant.compile.wgsl);
      const digest = createMaterialArtifactDigest(bytes);
      const specializationKey = createMaterialArtifactDigest(
        new TextEncoder().encode(
          JSON.stringify({
            module: pass.module,
            sourceClosure: pass.sourceClosureDigest,
            layout: pass.layoutIdentity,
            defines: lowerMaterialVariantContext(pass.context),
            artifact: digest,
            abi: pass.abi,
            profile: pass.context.profile,
            toolchain: pass.context.toolchain,
            compiler:
              input.compilerFingerprint ?? input.compilerVersion ?? MATERIAL_COOK_COMPILER_VERSION,
            wasm: input.wasm,
          }),
        ),
      );
      const existing = programs.get(specializationKey);
      const selections =
        pass.abi === undefined || variant.address === undefined
          ? [{ pass: pass.pass, context: pass.context }]
          : [
              {
                pass: pass.pass,
                context: pass.context,
                address: variant.address,
                entry:
                  variant.address === 'direct' ? pass.abi.directEntry : pass.abi.sceneIndexEntry,
                abi: pass.abi,
              },
            ];
      programs.set(specializationKey, {
        specializationKey,
        artifact: existing?.artifact ?? {
          mediaType: 'text/wgsl',
          path: `materials/programs/${digest.slice(7)}.wgsl`,
          digest,
          bytes,
        },
        selections: [...(existing?.selections ?? []), ...selections],
      });
    }
  }
  return [...programs.values()];
}

/** One derived program in the ordinary publication, selected from its authored pass. */
export function rayMaterialProgram(
  program: RaySurfaceProgram,
  pass: string,
  input: MaterialPublicationInput,
): MaterialCookProgram {
  const bytes = new TextEncoder().encode(program.wgsl);
  const digest = createMaterialArtifactDigest(bytes);
  const context = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  } as const;
  const specializationKey = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify({
        context,
        sourceClosure: program.sourceClosureDigest,
        layout: program.paramSchema,
        artifact: digest,
        compiler:
          input.compilerFingerprint ?? input.compilerVersion ?? MATERIAL_COOK_COMPILER_VERSION,
        wasm: input.wasm,
      }),
    ),
  );
  return {
    specializationKey,
    artifact: {
      mediaType: 'text/wgsl',
      path: `materials/programs/${digest.slice(7)}.wgsl`,
      digest,
      bytes,
    },
    selections: [{ pass, context, entry: 'cs_surface' }],
  };
}

export function cookedRecord(
  input: MaterialPublicationInput,
  resolved: MaterialAsset,
  sourceClosure: readonly string[],
  layoutIdentity: string,
  programs: readonly MaterialCookProgram[],
  inputFingerprint: string,
  layerPlanIdentity: string,
): CookedMaterialRecord {
  const artifactDigest = createMaterialProgramSetDigest(programs, resolved.passes ?? []);
  const materialSpecializationKey = artifactDigest;
  const materialContractDigest = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify({
        parameters: resolved.parameters ?? [],
        layerPlanIdentity,
        surface: resolved.surface ?? null,
      }),
    ),
  );
  const programIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify(programs.map((program) => program.specializationKey).sort()),
    ),
  );
  const pipelineIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify({
        programIdentity,
        passes: resolved.passes ?? [],
      }),
    ),
  );
  const identity = createMaterialCookIdentity({
    materialContractDigest,
    sourceRevision: input.sourceRevision ?? inputFingerprint,
    sourceClosureDigest: inputFingerprint,
    layoutIdentity,
    programIdentity,
    pipelineIdentity,
    materialPublicationIdentity: createMaterialArtifactDigest(
      new TextEncoder().encode(JSON.stringify({ guid: input.guid, values: resolved.values ?? {} })),
    ),
    compilerFingerprint: input.compilerFingerprint ?? 'unavailable',
    wasm: input.wasm ?? {
      sourceContentKey: 'unavailable',
      artifactSha256: 'unavailable',
      glueSha256: 'unavailable',
    },
    artifactDigest,
    valueGeneration: input.valueGeneration ?? 1,
    dependencyGeneration: input.dependencyGeneration ?? 1,
    cookGeneration: input.cookGeneration ?? 1,
  });
  const receipt: MaterialCookReceipt = {
    schemaVersion: 'material-cook/4',
    sourceClosure,
    profile: input.profile ?? MATERIAL_COOK_PROFILE,
    compilerVersion: input.compilerVersion ?? MATERIAL_COOK_COMPILER_VERSION,
    identity,
    derivedInterface: { layoutIdentity, layerPlanIdentity },
  };
  const authoredRefs = collectMaterialCookRefs(input.source);
  const resolvedRefs = collectMaterialCookRefs(resolved);
  const refs = {
    parent: unique([...authoredRefs.parent, ...resolvedRefs.parent]),
    textures: resolvedRefs.textures,
    samplers: resolvedRefs.samplers,
    modules: resolvedRefs.modules,
  };
  return validateCookedMaterialRecord({
    schemaVersion: 'material-cook/4',
    guid: input.guid,
    materialGuid: input.guid,
    publicationGeneration: input.cookGeneration ?? 1,
    specializationKey: materialSpecializationKey,
    artifactDigest,
    sourceClosure,
    parameterContract: {
      parameters: resolved.parameters ?? [],
      values: resolved.values ?? {},
    },
    authored: input.source,
    resolved: {
      passes: resolved.passes ?? [],
      parameters: resolved.parameters ?? [],
      values: resolved.values ?? {},
      ...(resolved.surface === undefined ? {} : { surface: resolved.surface }),
    },
    refs,
    programs,
    receipt,
  }).unwrap();
}
