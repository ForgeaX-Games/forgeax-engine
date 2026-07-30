import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import type { MaterialValue } from '@forgeax/engine-types';

export interface MaterialRenderPassProjection {
  readonly name: string;
  readonly module: string;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
  readonly artifactHash: string;
}

export interface MaterialRenderProjection {
  readonly materialGuid: string;
  readonly specializationKey: string;
  readonly artifactHash: string;
  readonly passes: readonly MaterialRenderPassProjection[];
  readonly runtimeValues: Readonly<Record<string, MaterialValue | null>>;
  readonly staticSelection: readonly string[];
}

function projectPass(
  record: CookedMaterialRecord,
  pass: CookedMaterialRecord['resolved']['passes'][number],
): MaterialRenderPassProjection {
  const program = pass.program;
  return {
    name: pass.name,
    module: program.module,
    ...(program.vertexEntry === undefined ? {} : { vertexEntry: program.vertexEntry }),
    ...(program.fragmentEntry === undefined ? {} : { fragmentEntry: program.fragmentEntry }),
    ...(program.moduleSlots === undefined ? {} : { moduleSlots: program.moduleSlots }),
    ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
    artifactHash: record.artifact.digest,
  };
}

export function assembleMaterialProjection(record: CookedMaterialRecord): MaterialRenderProjection {
  return {
    materialGuid: record.guid,
    specializationKey: record.receipt.inputDigest,
    artifactHash: record.artifact.digest,
    passes: record.resolved.passes.map((pass) => projectPass(record, pass)),
    runtimeValues: record.resolved.values,
    staticSelection: record.resolved.parameters
      .filter((parameter) => parameter.static)
      .map((parameter) => parameter.name)
      .sort(),
  };
}
