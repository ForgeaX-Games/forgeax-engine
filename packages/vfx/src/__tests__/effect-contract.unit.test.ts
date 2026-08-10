import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';

const reflection = {
  version: 1,
  parameters: {
    name: 'VfxParameters',
    fields: [
      { name: 'direction', type: 'vec3<f32>', offset: 0, size: 12, alignment: 16 },
      { name: 'speed', type: 'f32', offset: 16, size: 4, alignment: 4 },
    ],
    size: 32,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
} as const;

describe('VfxEffectContract', () => {
  it('derives defaults and packed values from the same reflection result', () => {
    const contract = createVfxEffectContract(reflection);
    const values = contract.createValues({ speed: 2.5, direction: [0, 1, 0] });
    expect(values.ok).toBe(true);
    if (!values.ok) return;
    expect(values.value.speed).toBe(2.5);
    expect(values.value.direction).toEqual([0, 1, 0]);
    expect(contract.pack(values.value).ok).toBe(true);
    expect(contract.fingerprint).toBe(reflection.fingerprint);
  });

  it('rejects unknown names, wrong dimensions, and wrong scalar kinds without assertions', () => {
    const contract = createVfxEffectContract(reflection);

    const unknown = contract.createValues({ missing: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('vfx-value-unknown-field');

    const wrongDimension = contract.createValues({ direction: [0, 1] });
    expect(wrongDimension.ok).toBe(false);
    if (!wrongDimension.ok) expect(wrongDimension.error.code).toBe('vfx-value-type-mismatch');

    const wrongScalar = contract.validateValues(JSON.parse('{"speed":"fast"}'));
    expect(wrongScalar.ok).toBe(false);
    if (!wrongScalar.ok) expect(wrongScalar.error.code).toBe('vfx-value-type-mismatch');
  });
});
