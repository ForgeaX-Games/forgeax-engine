import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import { ok, type AssetGuid as AssetGuidType } from '@forgeax/engine-types';
import { createEmptyScene } from './lib.ts';

// *.pack.ts is executable authoring source. The build derives pack.json payloads
// and pack-index.json from it. External files instead keep identity/import policy
// in adjacent *.meta.json sidecars; generated outputs must not be hand-edited.
function guid(value: string): AssetGuidType {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}

const assets = {
  'scene/empty': {
    guid: guid('019fb7ce-1000-7000-8000-000000000001'),
    kind: 'scene',
    name: 'Empty Scene',
  },
} as const;

export default {
  schemaVersion: '1.0.0',
  packageId: guid('019fb7ce-1000-7000-8000-000000000000'),
  name: 'Empty Game',
  assets,
  externalAssets: {},
  build: () => ok({ 'scene/empty': createEmptyScene() }),
} satisfies ScriptablePackDefinition<typeof assets>;
