import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import { type RenderPublication, RenderPublicationError } from './contract';

/** Admit immutable producer artifacts before the full Renderer prepares their pipelines. */
export function installPublicationPrograms(
  assets: AssetRegistry,
  programs: RenderPublication['programs'],
): void {
  if (programs.length === 0) return;
  const validation = new MaterialArtifactRegistry();
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const keys = new Set<string>();
  for (const row of programs) {
    if (keys.has(row.key) || (row.artifact !== undefined && row.artifact.key !== row.key))
      throw new RenderPublicationError({
        reason: 'shape',
        subject: 'duplicate or mismatched program key',
      });
    keys.add(row.key);
    shaders.installMaterialArtifact(row.key, row.shader);
    const previous = assets.shaderRegistry.findMaterialArtifact(row.key);
    if (
      previous.ok &&
      (previous.value.source !== row.shader.source ||
        JSON.stringify(previous.value.paramSchema) !== JSON.stringify(row.shader.paramSchema) ||
        JSON.stringify(previous.value.receipt) !== JSON.stringify(row.shader.receipt))
    ) {
      throw new RenderPublicationError({
        reason: 'shape',
        subject: `conflicting immutable shader ${row.key}`,
      });
    }
    if (row.artifact !== undefined) {
      const existing = assets.getMaterialArtifact(row.key);
      if (existing !== undefined) validation.register(existing).unwrap();
      validation.register(row.artifact).unwrap();
    }
  }
  for (const row of programs) {
    if (row.artifact !== undefined) assets.materialArtifactRegistry.register(row.artifact).unwrap();
    if (!assets.shaderRegistry.findMaterialArtifact(row.key).ok)
      assets.shaderRegistry.installMaterialArtifact(row.key, row.shader);
  }
}
