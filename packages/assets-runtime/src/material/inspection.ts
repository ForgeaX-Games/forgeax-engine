import type { MaterialReady } from './loader.js';

/**
 * Read-only facts for one GUID after the MaterialReady gate succeeds.
 * `status` is retained for the existing runtime API; `readiness` is the
 * machine-readable first-level field for inspection consumers. This owner
 * does not invent transport provenance or compare transport URLs.
 */
export interface MaterialRuntimeInfo {
  readonly materialGuid: string;
  readonly readiness: 'ready';
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly layoutIdentity: string;
  readonly dependencies: readonly string[];
  readonly profile: string;
  readonly sourceClosure: readonly string[];
  readonly parameterContract: MaterialReady['parameterContract'];
  readonly refs: MaterialReady['record']['refs'];
  readonly receipt: MaterialReady['record']['receipt'];
  readonly status: 'Ready';
}

export function inspectMaterialRuntime(ready: MaterialReady): MaterialRuntimeInfo {
  return {
    materialGuid: ready.materialGuid,
    readiness: 'ready',
    publicationGeneration: ready.publicationGeneration,
    specializationKey: ready.specializationKey,
    artifactDigest: ready.artifactDigest,
    layoutIdentity: ready.record.receipt.identity.layoutIdentity,
    dependencies: [
      ...ready.record.refs.parent,
      ...ready.record.refs.textures,
      ...ready.record.refs.samplers,
      ...ready.record.refs.modules,
    ],
    profile: ready.record.receipt.profile,
    sourceClosure: ready.sourceClosure,
    parameterContract: ready.parameterContract,
    refs: ready.record.refs,
    receipt: ready.record.receipt,
    status: 'Ready',
  };
}
