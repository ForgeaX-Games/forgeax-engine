import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildScriptablePack } from '../scriptable-pack.js';
import { createStandardAssetOutputProducerRegistry } from '../scriptable-pack-output-producers.js';

const PACKAGE_ID = AssetGuid.parse('019e3969-1d48-7c3b-ac24-6d68f457065e');
const HERO_GUID = AssetGuid.parse('019e3969-1d48-7c3b-ac24-6d68f457065f');

describe('ScriptablePack terminal product contract', () => {
  it('keeps one complete product shape for direct and custom producer outputs', async () => {
    const result = await buildScriptablePack({
      definition: {
        schemaVersion: '1.0.0',
        packageId: PACKAGE_ID.ok ? PACKAGE_ID.value : ({} as never),
        assets: {
          hero: { guid: HERO_GUID.ok ? HERO_GUID.value : ({} as never), kind: 'texture' },
        },
        externalAssets: {},
        build: async () =>
          ok({
            hero: {
              kind: 'texture',
              width: 1,
              height: 1,
              format: 'rgba8unorm',
              data: new Uint8Array(),
              colorSpace: 'srgb',
              mipmap: false,
            },
          }),
      },
      sourcePath: 'hero.pack.ts',
      outputs: createStandardAssetOutputProducerRegistry(),
      sourceClosure: [{ path: 'hero.pack.ts', digest: 'sha256:hero' }],
      authoringContractVersion: 'scriptable-pack-production/1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.product).toHaveProperty('refs');
    expect(result.value.product).toHaveProperty('artifacts');
    expect(result.value.product).toHaveProperty('receipts');
    expect(result.value.product).toHaveProperty('diagnostics');
    expect(result.value.product).toHaveProperty('sourceRevision');
  });
});
