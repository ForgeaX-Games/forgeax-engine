import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { Asset } from '@forgeax/engine-types';

/** Render-only projection supplied by the owner of decoded asset payloads. */
export interface RenderAssetResolver {
  readonly epoch: number;
  lookup<T extends Asset>(guid: string): T | undefined;
  guidOf(asset: Asset): string | undefined;
}

export interface RenderAssetPort {
  readonly epoch: number;
  readonly shaderRegistry: ShaderRegistry;
  lookup<T extends Asset>(guid: string): T | undefined;
  guidOf(asset: Asset): string | undefined;
  materialShaderTextureFieldNames(shaderId: string): readonly string[];
}

export function createRenderAssetPort(
  shaderRegistry: ShaderRegistry,
  resolver: RenderAssetResolver = emptyResolver,
): RenderAssetPort {
  return {
    get epoch() {
      return resolver.epoch;
    },
    shaderRegistry,
    lookup: <T extends Asset>(guid: string) => resolver.lookup<T>(guid),
    guidOf: (asset: Asset) => resolver.guidOf(asset),
    materialShaderTextureFieldNames(shaderId: string): readonly string[] {
      const artifact = shaderRegistry.findMaterialArtifact(shaderId);
      if (!artifact.ok) return [];
      return artifact.value.paramSchema
        .filter((parameter) => parameter.type === 'texture2d')
        .map((parameter) => parameter.name);
    },
  };
}

const emptyResolver: RenderAssetResolver = Object.freeze({
  epoch: 0,
  lookup: () => undefined,
  guidOf: () => undefined,
});
