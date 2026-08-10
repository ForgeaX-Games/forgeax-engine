import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveHealthPickupContact } from '../assets/plugins/health-pickup.js';

describe('game-default authored health pickup', () => {
  it('restores exactly one missing heart and refuses full health', () => {
    expect(resolveHealthPickupContact({ current: 2, max: 3 })).toEqual({
      health: 3,
      admitted: true,
    });
    expect(resolveHealthPickupContact({ current: 3, max: 3 })).toEqual({
      health: 3,
      admitted: false,
    });
  });

  it('keeps the pickup identity and presentation in the authored SceneAsset', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Array<{
        guid: string;
        kind: string;
        refs: string[];
        payload: { entities?: Array<{ localId: number; components: Record<string, Record<string, unknown>> }> };
      }>;
    };
    const scene = pack.assets.find((asset) => asset.guid === '1036f6f0-d3c2-5f31-9593-3432942d4c93');
    const pickup = scene?.payload.entities?.find((entity) => entity.components.Name?.value === 'HealthPickup');

    expect(scene?.kind).toBe('scene');
    expect(pickup).toMatchObject({
      localId: 26,
      components: {
        Name: { value: 'HealthPickup' },
        Transform: { pos: [2.5, 0.55, 0], scale: [0.45, 0.45, 0.45] },
        MeshFilter: { assetHandle: 4 },
      },
    });
    const materialIndex = (pickup?.components.MeshRenderer?.materials as number[] | undefined)?.[0];
    expect(typeof materialIndex).toBe('number');
    expect(scene?.refs[materialIndex ?? -1]).toBe('019f7000-0000-7000-8000-000000000025');
    expect(pack.assets.some((asset) => asset.guid === '019f7000-0000-7000-8000-000000000025' && asset.kind === 'material')).toBe(true);
  });
});
