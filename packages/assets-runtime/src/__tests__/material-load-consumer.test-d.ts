import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRegistry } from '../index.js';

declare const assets: Pick<AssetRegistry, 'loadByGuid'>;
declare const materialGuid: AssetGuid;

describe('MaterialAsset loadByGuid consumer', () => {
  it('narrows the successful load result without a cast', async () => {
    const loaded = await assets.loadByGuid<MaterialAsset>(materialGuid);
    if (!loaded.ok) return;

    expectTypeOf(loaded.value.values).toMatchTypeOf<MaterialAsset['values']>();
    expectTypeOf(loaded.value.passes).toMatchTypeOf<MaterialAsset['passes']>();
  });
});
