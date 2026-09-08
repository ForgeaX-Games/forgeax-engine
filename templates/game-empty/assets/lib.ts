import type { SceneAsset } from '@forgeax/engine-types';

/** Pure asset builders belong here so several ScriptablePacks can reuse them. */
export function createEmptyScene(): SceneAsset {
  return { kind: 'scene', entities: [] };
}
