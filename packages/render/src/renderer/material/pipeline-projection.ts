import type { MaterialRuntimeArtifact } from '@forgeax/engine-shader';
import type { MaterialValue } from '@forgeax/engine-types';
import type { MaterialRenderProjection } from './assembly.js';

export interface MaterialPipelineProjection {
  readonly specializationKey: string;
  readonly artifactHash: string;
  readonly passes: MaterialRenderProjection['passes'];
}

export interface MaterialPipelineReady extends MaterialPipelineProjection {
  readonly kind: 'ready';
  readonly artifact: MaterialRuntimeArtifact;
}

export interface MaterialPipelineMiss {
  readonly kind: 'error';
  readonly error: {
    readonly code: 'material-specialization-not-cooked';
    readonly expected: string;
    readonly hint: string;
    readonly detail: { readonly specializationKey: string };
  };
}

export function projectMaterialPipeline(
  projection: MaterialRenderProjection,
): MaterialPipelineProjection {
  return {
    specializationKey: projection.specializationKey,
    artifactHash: projection.artifactHash,
    passes: projection.passes,
  };
}

export function updateMaterialRuntimeValues(
  projection: MaterialRenderProjection,
  values: Readonly<Record<string, MaterialValue | null>>,
): MaterialRenderProjection {
  return {
    ...projection,
    runtimeValues: { ...projection.runtimeValues, ...values },
  };
}

export function routeMaterialPipeline(args: {
  readonly projection: MaterialRenderProjection;
  readonly lookupArtifact: (key: string) => MaterialRuntimeArtifact | undefined;
}): MaterialPipelineReady | MaterialPipelineMiss {
  const artifact = args.lookupArtifact(args.projection.specializationKey);
  if (artifact === undefined || artifact.digest !== args.projection.artifactHash) {
    return {
      kind: 'error',
      error: {
        code: 'material-specialization-not-cooked',
        expected: 'a published artifact for the cooked specialization key',
        hint: 'cook and publish the material specialization before rendering it',
        detail: { specializationKey: args.projection.specializationKey },
      },
    };
  }
  return { kind: 'ready', ...projectMaterialPipeline(args.projection), artifact };
}
