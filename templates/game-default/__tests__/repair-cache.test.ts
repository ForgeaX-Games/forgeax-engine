import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
});
