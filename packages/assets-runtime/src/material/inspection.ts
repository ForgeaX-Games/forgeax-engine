import type { MaterialReady } from './loader.js';

export interface MaterialRuntimeInfo {
  readonly guid: string;
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly dependencies: readonly string[];
  readonly profile: string;
  readonly sourceClosure: readonly string[];
  readonly status: 'Ready';
}

export function inspectMaterialRuntime(ready: MaterialReady): MaterialRuntimeInfo {
  return {
    guid: ready.guid,
    specializationKey: ready.specializationKey,
    artifactDigest: ready.artifact.digest,
    dependencies: [
      ...ready.record.refs.parent,
      ...ready.record.refs.textures,
      ...ready.record.refs.samplers,
      ...ready.record.refs.modules,
    ],
    profile: ready.record.receipt.profile,
    sourceClosure: ready.record.receipt.sourceClosure,
    status: 'Ready',
  };
}
