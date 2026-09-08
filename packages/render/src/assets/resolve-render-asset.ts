import type { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, Result } from '@forgeax/engine-types';

export type RenderAssetResolutionError =
  ReturnType<World['sharedRefs']['resolve']> extends Result<unknown, infer E> ? E : never;

/** Resolve a render handle through the World that owns its shared-reference lifetime. */
export function resolveRenderAsset<T extends Asset>(
  world: World,
  handle: Handle<string, 'shared'>,
): Result<T, RenderAssetResolutionError> {
  return world.sharedRefs.resolve<string, T>(handle) as Result<T, RenderAssetResolutionError>;
}
