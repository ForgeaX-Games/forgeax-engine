import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';

export interface MaterialShaderArtifact {
  readonly material: string;
  readonly pass: string;
  readonly wgsl: string;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  readonly specializationKey?: string;
}

export function isMaterialShaderArtifact(value: unknown): value is MaterialShaderArtifact {
  if (value === null || typeof value !== 'object') return false;
  const artifact = value as Partial<MaterialShaderArtifact>;
  return (
    typeof artifact.material === 'string' &&
    typeof artifact.pass === 'string' &&
    typeof artifact.wgsl === 'string' &&
    Array.isArray(artifact.bindings) &&
    Array.isArray(artifact.deps) &&
    Array.isArray(artifact.vertexInputs)
  );
}
