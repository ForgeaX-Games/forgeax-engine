import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

export function materialArtifactProgramIdentity(artifact: MaterialShaderArtifact): string {
  return artifact.specializationKey === undefined
    ? artifact.program.identity
    : `specialization:${artifact.specializationKey}`;
}
