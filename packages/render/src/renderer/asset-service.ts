import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { ImportTransport } from '@forgeax/engine-types';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';

/** Default asset service for the standalone render construction seam. */
export function createAssetRegistry(
  shaderRegistry: ShaderRegistry,
  importTransport: ImportTransport | undefined,
): AssetRegistry {
  return new AssetRegistry(shaderRegistry, importTransport, [audioLoader], postSpawnResolveJoints);
}
