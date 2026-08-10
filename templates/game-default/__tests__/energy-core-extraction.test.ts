import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveExtractionProgress,
  resolveEnergyCoreContacts,
} from '../assets/plugins/energy-core-extraction.js';

describe('energy-core extraction', () => {
  it('admits each authored core once and ignores wrong or duplicate contacts', () => {
    const roster = new Map([[101, 0], [102, 1], [103, 2]]);
    expect(resolveEnergyCoreContacts([700, 101, 101, 999], roster, 0)).toEqual({
      collectedMask: 1,
      admitted: [101],
    });
    expect(resolveEnergyCoreContacts([101, 102, 102, 700], roster, 1)).toEqual({
      collectedMask: 3,
      admitted: [102],
    });
    expect(resolveEnergyCoreContacts([103, 999], roster, 3)).toEqual({
      collectedMask: 7,
      admitted: [103],
    });
  });

  it('activates only at exactly three of three authored cores', () => {
    expect(deriveExtractionProgress(0, 3)).toEqual({ collected: 0, total: 3, active: false });
    expect(deriveExtractionProgress(3, 3)).toEqual({ collected: 2, total: 3, active: false });
    expect(deriveExtractionProgress(7, 3)).toEqual({ collected: 3, total: 3, active: true });
  });

  it('authors three unique cores and one beacon in the default SceneAsset', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8'));
    const scene = pack.assets.find((asset: { guid?: string }) => asset.guid === '1036f6f0-d3c2-5f31-9593-3432942d4c93');
    const entities = scene?.payload.entities ?? [];
    type SceneEntity = { localId: number; components: { Name?: { value?: string }; Transform?: { pos?: number[] } } };
    const named = new Map<string | undefined, SceneEntity>(
      (entities as SceneEntity[]).map((entity) => [entity.components.Name?.value, entity]),
    );
    const cores = ['EnergyCoreAlpha', 'EnergyCoreBeta', 'EnergyCoreGamma'].map((name) => named.get(name));
    expect(cores.map((core) => core?.localId)).toEqual([27, 28, 29]);
    expect(new Set(cores.map((core) => JSON.stringify(core?.components.Transform?.pos))).size).toBe(3);
    expect(named.get('ExtractionBeacon')).toMatchObject({
      localId: 30,
      components: {
        Name: { value: 'ExtractionBeacon' },
        Transform: { pos: [0, 0.35, -4.5] },
      },
    });
  });
});
