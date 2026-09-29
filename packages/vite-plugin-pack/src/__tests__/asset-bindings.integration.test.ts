import { describe, expect, it } from 'vitest';
import {
  type AssetBindingCatalog,
  assetBindingCatalogFromInventory,
  assetBindingDeclarationSource,
  createAssetBindingPlugin,
} from '../build/asset-bindings.js';

describe('asset binding projections', () => {
  it('projects one literal virtual module from the author inventory', async () => {
    const catalog: AssetBindingCatalog = {
      assets: [
        {
          guid: '00000000-0000-0000-0000-000000000011',
          sourceKey: 'hero/body',
          kind: 'mesh',
        },
      ],
      scenes: [],
    };
    const plugin = createAssetBindingPlugin(() => catalog);
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    const module = await resolveId('virtual:forgeax/assets');
    const source = await load('virtual:forgeax/assets');

    expect(module).toBe('\0virtual:forgeax/assets');
    expect(source).toContain('"sourceKey":"hero/body"');
    expect(source).toContain('function asset');
  });

  it('projects sceneEntity addresses and a rebuildable declaration surface', async () => {
    const plugin = createAssetBindingPlugin(() => ({
      assets: [],
      scenes: [{ sourceKey: 'level/main', entityKeys: ['player-spawn', 'follow-camera'] }],
    }));
    const load = plugin.load as (id: string) => string | undefined;
    const source = await load('virtual:forgeax/assets');

    expect(source).toContain('function sceneEntity');
    expect(source).toContain('player-spawn');
    expect(source).toContain('follow-camera');
    expect(
      assetBindingDeclarationSource({
        assets: [],
        scenes: [{ sourceKey: 'level/main', entityKeys: ['player-spawn', 'follow-camera'] }],
      }),
    ).toContain("declare module 'virtual:forgeax/assets'");
    expect(
      assetBindingDeclarationSource({
        assets: [
          { guid: '00000000-0000-0000-0000-000000000013', sourceKey: 'world/main', kind: 'scene' },
        ],
        scenes: [],
      }),
    ).toContain('"world/main": import(\'@forgeax/engine/types\').AssetRef<"scene">');
  });

  it('fails closed for duplicate and missing entity keys', async () => {
    const plugin = createAssetBindingPlugin(() => ({
      assets: [],
      scenes: [{ sourceKey: 'level/main', entityKeys: ['player', 'player'] }],
    }));

    try {
      const load = plugin.load as (id: string) => string | undefined;
      load('virtual:forgeax/assets');
      throw new Error('duplicate binding was accepted');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'asset-binding-duplicate',
        expected: expect.stringContaining('entity keys'),
      });
    }
  });

  it('projects assets and scene bindings from one validated inventory', () => {
    const projected = assetBindingCatalogFromInventory({
      declarations: [
        {
          guid: '00000000-0000-0000-0000-000000000012',
          sourceKey: 'world/main',
          kind: 'scene',
          payload: {},
          refs: [],
          sceneEntityKeys: ['player'],
        },
      ],
    });

    expect(projected).toEqual({
      assets: [
        { guid: '00000000-0000-0000-0000-000000000012', sourceKey: 'world/main', kind: 'scene' },
      ],
      scenes: [{ sourceKey: 'world/main', entityKeys: ['player'] }],
    });
  });
});
