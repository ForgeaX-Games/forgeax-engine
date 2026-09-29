import { describe, expect, it } from 'vitest';
import {
  type AtmosphereParameters,
  type EnvironmentCandidate,
  type EnvironmentFrame,
  type FogCandidate,
  selectEnvironmentFrame,
} from '../extract/environment';

const atmosphereParameters: AtmosphereParameters = {
  turbidity: 2,
  rayleigh: 1,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  sunAngularRadius: 0.004675,
  circumsolarStrength: 1,
  circumsolarWidth: 1,
};

function unwrapFrame(result: ReturnType<typeof selectEnvironmentFrame>): EnvironmentFrame {
  if (!result.ok) throw result.error;
  return result.value;
}

const image = (entityKey: number, sourceKey: string): EnvironmentCandidate => ({
  kind: 'image',
  entityKey,
  sourceKey,
});
const atmosphere = (entityKey: number, sourceKey: string): EnvironmentCandidate => ({
  kind: 'atmosphere',
  entityKey,
  sourceKey,
  atmosphere: atmosphereParameters,
});
const fog = (entityKey: number): FogCandidate => ({
  entityKey,
  color: [0.4, 0.5, 0.6],
  density: 0.01,
  heightFalloff: 0.2,
  maxOpacity: 0.9,
});

describe('immutable frame plan contract', () => {
  it('selects none, one image, or one atmosphere deterministically', () => {
    expect(unwrapFrame(selectEnvironmentFrame([], [])).source.kind).toBe('none');
    expect(unwrapFrame(selectEnvironmentFrame([image(2, 'image-a')], [])).source).toEqual({
      kind: 'image',
      sourceKey: 'image-a',
      entityKey: 2,
    });
    expect(unwrapFrame(selectEnvironmentFrame([atmosphere(7, 'sky-a')], [])).source).toEqual({
      kind: 'atmosphere',
      sourceKey: 'sky-a',
      entityKey: 7,
      atmosphere: atmosphereParameters,
    });
  });

  it('rejects mixed source kinds and conflicting source keys', () => {
    expect(selectEnvironmentFrame([image(1, 'a'), atmosphere(2, 'b')], [])).toMatchObject({
      ok: false,
      error: { code: 'environment-source-conflict' },
    });
    expect(selectEnvironmentFrame([image(1, 'a'), image(2, 'b')], [])).toMatchObject({
      ok: false,
      error: { code: 'environment-source-conflict' },
    });
  });

  it('keeps Fog independent from environment source and bounds cardinality', () => {
    const withoutFog = unwrapFrame(selectEnvironmentFrame([], []));
    expect(withoutFog.fog).toBeUndefined();
    const withFog = unwrapFrame(selectEnvironmentFrame([], [fog(4)]));
    expect(withFog.fog?.entityKey).toBe(4);
    expect(selectEnvironmentFrame([], [fog(4), fog(8)])).toMatchObject({
      ok: false,
      error: { code: 'fog-cardinality' },
    });
  });

  it('returns detached facts without GPU handles and freezes nested values', () => {
    const result = selectEnvironmentFrame([image(1, 'stable')], [fog(3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.source)).toBe(true);
    expect('device' in result.value).toBe(false);
    expect('texture' in result.value).toBe(false);
    expect('buffer' in result.value).toBe(false);
  });
});

describe('auto exposure resize contract', () => {
  it('retains accepted EV while changing the target generation', async () => {
    const { commitAutoExposureCandidate, createAutoExposureState, resetAutoExposureState } =
      await import('../pipeline/standard-output/auto-exposure/state');
    const initial = createAutoExposureState({ fallback: 1, targetGeneration: 1, deviceEpoch: 1 });
    if (!initial.ok) throw initial.error;
    const accepted = commitAutoExposureCandidate(initial.value, {
      ev: 1.5,
      generation: 1,
      deviceEpoch: 1,
      frameId: 3,
    });
    const resized = resetAutoExposureState(accepted, 'camera-change', {
      targetGeneration: 2,
      deviceEpoch: 1,
    });

    expect(resized.acceptedEv).toBe(1.5);
    expect(resized.lastKnownGood).toBe(1.5);
    expect(resized.targetGeneration).toBe(2);
    expect(resized.receipt.committed).toBe(false);
  });
});
