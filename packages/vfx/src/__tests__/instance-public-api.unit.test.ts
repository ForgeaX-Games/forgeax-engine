import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { ParticleEffectInstance } from '../instance.js';

const reflection = {
  version: 1,
  parameters: {
    name: 'VfxParameters',
    fields: [{ name: 'intensity', type: 'f32', offset: 0, size: 4, alignment: 4 }],
    size: 16,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  fingerprint: 'sha256:public-runtime',
} as const;

describe('public VFX instance API', () => {
  it('keeps legal public patches typed and reports illegal runtime payloads', () => {
    const contract = createVfxEffectContract<{ readonly intensity: number }>(reflection);
    const instance = new ParticleEffectInstance(contract, { initialValues: { intensity: 1 } });

    expect(instance.patch({ intensity: 2 }).ok).toBe(true);
    expect(instance.patch(JSON.parse('{"intensity":"bright"}')).ok).toBe(false);
    expect(instance.values).toEqual({ intensity: 1 });
    expect(instance.pendingPatchCount).toBe(1);
  });
});
