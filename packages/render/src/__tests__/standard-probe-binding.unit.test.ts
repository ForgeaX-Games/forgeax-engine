import { describe, expect, it } from 'vitest';
import { resolveReflectionProbeBinding } from '../record/frame-lighting';
import { standardReflectionProbeIndex } from '../record/main-pass';

describe('Standard scene reflection probe binding', () => {
  it('maps a selected scene probe to both Standard lanes', () => {
    const selection = {
      kind: 'probe' as const,
      worldId: 2,
      entityKey: 7,
      normalizedDistance: 0.25,
    };
    expect(resolveReflectionProbeBinding(selection)).toEqual({ probeIndex: 7, useSkylight: false });
    expect(standardReflectionProbeIndex(selection)).toBe(7);
  });

  it('uses Skylight without a per-material probe identity', () => {
    const selection = { kind: 'skylight' as const };
    expect(resolveReflectionProbeBinding(selection)).toEqual({
      probeIndex: undefined,
      useSkylight: true,
    });
    expect(standardReflectionProbeIndex(selection)).toBeUndefined();
  });
});
