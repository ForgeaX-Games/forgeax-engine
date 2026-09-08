import { readFileSync } from 'node:fs';
import type { World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { LocalEntityId } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { expandLoadedScene, type LoadedScene } from '../assets/plugins/scene-runtime.js';
import { resolveRepairCacheImpact } from '../assets/plugins/repair-cache.js';

describe('game-default nested repair cache', () => {
  it('opens only for a charged hit admitted on the authored target', () => {
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 1, opened: false })).toBe('ordinary');
    expect(resolveRepairCacheImpact({ authoredTarget: false, impactScale: 2, opened: false })).toBe('other-target');
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 2, opened: false })).toBe('open');
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 2, opened: true })).toBe('already-open');
  });

  it('authors one hidden repair pickup under NestedTarget', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Array<{
        guid: string;
        kind: string;
        payload: {
          entities?: Array<{ localId: number; components: Record<string, Record<string, unknown>> }>;
          mounts?: Array<{ memberFirst: number; memberCount: number }>;
        };
      }>;
    };
    const primary = pack.assets.find((asset) => asset.guid === '1036f6f0-d3c2-5f31-9593-3432942d4c93');
    const nested = pack.assets.find((asset) => asset.guid === '0f20e111-5b2f-5a77-9a02-2f5d1e9c7a11');
    const repair = nested?.payload.entities?.find(
      (entity) => entity.components.Name?.value === 'NestedRepairPickup',
    );

    expect(primary?.payload.mounts).toContainEqual(expect.objectContaining({ memberFirst: 24, memberCount: 2 }));
    expect(repair).toMatchObject({
      localId: 1,
      components: {
        Name: { value: 'NestedRepairPickup' },
        ChildOf: { parent: 0 },
        Transform: { pos: [0, 0.8, -1.2], scale: [0.38, 0.38, 0.38] },
      },
    });
  });

  it('expands a host-projected numeric nested mount through World.sharedRefs', async () => {
    const nested = {
      kind: 'scene',
      entities: [
        { localId: 0, components: { Name: { value: 'NestedTarget' } } },
        { localId: 1, components: { Name: { value: 'NestedRepairPickup' } } },
      ],
    } as const;
    const world = {
      sharedRefs: { resolve: () => ({ ok: true, value: nested }) },
    } as unknown as World;
    const assets = {
      loadByGuid: async () => {
        throw new Error('numeric projected mount should not load by GUID');
      },
    } as unknown as AssetRegistry;
    const authored = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 23 as LocalEntityId,
          source: 7,
          memberFirst: 24 as LocalEntityId,
          memberCount: 2,
        },
      ],
    } as const;
    const loaded = { mapping: new Map(), nodes: [] } as LoadedScene;

    const expanded = await expandLoadedScene(world, assets, authored, loaded);

    expect(expanded.nodes.map((node) => [node.localId, node.components.Name?.value])).toEqual([
      [24, 'NestedTarget'],
      [25, 'NestedRepairPickup'],
    ]);
  });
});
