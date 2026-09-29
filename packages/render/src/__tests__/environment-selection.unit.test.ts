import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectEnvironment } from '../environment/frame';
import type {
  AtmosphereParameters,
  EnvironmentCandidate,
  FogCandidate,
} from '../extract/environment';
import { SunCardinalityError } from '../index';

const atmosphereParameters: AtmosphereParameters = {
  turbidity: 2,
  rayleigh: 1,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  sunAngularRadius: 0.004675,
  circumsolarStrength: 1,
  circumsolarWidth: 1,
};

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

const fog = (entityKey: number, density = 0.01): FogCandidate => ({
  entityKey,
  color: [0.4, 0.5, 0.6],
  density,
  heightFalloff: 0.2,
  maxOpacity: 0.8,
});

const sun = (entityKey: number) => ({
  entityKey,
  direction: [0, -1, 0] as const,
  color: [1, 0.95, 0.9] as const,
  intensity: 2,
});

function selection(
  environments: readonly EnvironmentCandidate[],
  fogs: readonly FogCandidate[] = [],
  suns: readonly ReturnType<typeof sun>[] = [],
  lane: 'direct' | 'clustered' = 'direct',
) {
  return selectEnvironment({
    environments,
    fogs,
    suns,
    lane,
  });
}

describe('Environment and Fog selection (M2)', () => {
  it.each([
    ['none', [], undefined],
    ['image', [image(2, 'image-a')], undefined],
    ['atmosphere', [atmosphere(3, 'sky-a')], [sun(4)]],
  ] as const)('selects the %s cardinality without a first-hit fallback', (kind, environments, suns) => {
    const result = selection(environments, [], suns ?? []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.kind).toBe(kind);
  });

  it('rejects N environment owners with stable structured ownership details', () => {
    const forward = selection([image(2, 'image-a'), atmosphere(3, 'sky-a')], [], [sun(4)]);
    const reverse = selection([atmosphere(3, 'sky-a'), image(2, 'image-a')], [], [sun(4)]);

    expect(forward.ok).toBe(false);
    expect(reverse.ok).toBe(false);
    if (forward.ok || reverse.ok) return;
    expect(forward.error.code).toBe('environment-source-conflict');
    expect(forward.error.expected).toContain('exactly one');
    expect(forward.error.hint).toContain('one');
    expect(forward.error.detail).toEqual(reverse.error.detail);
    expect(forward.error.detail.owners).toEqual([
      { kind: 'image', entityKey: 2, sourceKey: 'image-a' },
      { kind: 'atmosphere', entityKey: 3, sourceKey: 'sky-a' },
    ]);
  });

  it.each([
    ['missing', [], 'sun', 0],
    ['multiple', [sun(4), sun(5)], 'sun', 2],
  ] as const)('reports %s atmosphere Sun cardinality through expected/hint/detail', (_name, suns, field, value) => {
    const result = selection([atmosphere(3, 'sky-a')], [], suns);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.expected).toContain('sun');
    expect(result.error.hint).toContain('sun');
    expect(result.error.detail).toMatchObject({ field, value });
    expect(result.error).toBeInstanceOf(SunCardinalityError);
  });

  it('rejects invalid Fog parameters at the field owner', () => {
    const result = selection([], [fog(8, -1)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.expected).toContain('finite');
    expect(result.error.hint).toContain('density');
    expect(result.error.detail).toMatchObject({ field: 'density', value: -1 });
  });

  it.each([
    ['turbidity', { turbidity: -1 }],
    ['rayleigh', { rayleigh: Number.NaN }],
    ['mieCoefficient', { mieCoefficient: -0.001 }],
    ['mieDirectionalG', { mieDirectionalG: 1.1 }],
    ['sunAngularRadius', { sunAngularRadius: Number.POSITIVE_INFINITY }],
    ['circumsolarStrength', { circumsolarStrength: -0.001 }],
    ['circumsolarWidth', { circumsolarWidth: 0.1 }],
  ] as const)('rejects invalid Atmosphere.%s with field-owned detail', (field, override) => {
    const result = selection(
      [
        {
          kind: 'atmosphere',
          entityKey: 3,
          sourceKey: 'sky-a',
          atmosphere: { ...atmosphereParameters, ...override },
        },
      ],
      [],
      [sun(4)],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('atmosphere-invalid-parameter');
    expect(result.error.detail).toMatchObject({ field });
    expect(result.error.expected).toContain('finite');
    expect(result.error.hint).toContain(field);
  });

  it.each([
    ['turbidity', 1, 20],
    ['rayleigh', 0, 100],
    ['mieCoefficient', 0, 100],
    ['mieDirectionalG', 0, 0.999],
    ['sunAngularRadius', 0, 1],
    ['circumsolarStrength', 0, 4],
    ['circumsolarWidth', 0.25, 4],
  ] as const)('accepts the documented %s boundaries', (field, minimum, maximum) => {
    for (const value of [minimum, maximum]) {
      const result = selection(
        [
          {
            kind: 'atmosphere',
            entityKey: 3,
            sourceKey: 'sky-a',
            atmosphere: { ...atmosphereParameters, [field]: value },
          },
        ],
        [],
        [sun(4)],
      );
      expect(result.ok).toBe(true);
    }
  });

  it.each([
    ['turbidity', [0, 21]],
    ['rayleigh', [Number.NEGATIVE_INFINITY, Number.NaN]],
    ['mieCoefficient', [-Number.MIN_VALUE, Number.POSITIVE_INFINITY]],
    ['mieDirectionalG', [-Number.MIN_VALUE, 1]],
    ['sunAngularRadius', [-Number.MIN_VALUE, Number.POSITIVE_INFINITY]],
    ['circumsolarStrength', [-Number.MIN_VALUE, 4.001]],
    ['circumsolarWidth', [0.249, 4.001]],
  ] as const)('rejects %s values outside the shared shader domain', (field, values) => {
    for (const value of values) {
      const result = selection(
        [
          {
            kind: 'atmosphere',
            entityKey: 3,
            sourceKey: 'sky-a',
            atmosphere: { ...atmosphereParameters, [field]: value },
          },
        ],
        [],
        [sun(4)],
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.detail).toMatchObject({ field, value });
      expect(result.error.expected).toContain('finite');
      expect(result.error.hint).toContain(field);
    }
  });

  it('includes all Atmosphere fields in the deterministic source signature', () => {
    const baseline = selection([atmosphere(3, 'sky-a')], [], [sun(4)]);
    const changed = selection(
      [
        {
          kind: 'atmosphere',
          entityKey: 3,
          sourceKey: 'sky-a',
          atmosphere: { ...atmosphereParameters, rayleigh: 1.25 },
        },
      ],
      [],
      [sun(4)],
    );
    expect(baseline.ok).toBe(true);
    expect(changed.ok).toBe(true);
    if (!baseline.ok || !changed.ok) return;
    expect(baseline.value.source).toMatchObject({ atmosphere: atmosphereParameters });
    expect(baseline.value.signature).not.toBe(changed.value.signature);
    expect(baseline.value.signature).toContain('sunAngularRadius');
    expect(baseline.value.signature).toContain('circumsolarStrength');
    expect(baseline.value.signature).toContain('circumsolarWidth');
  });

  it('keeps Fog orthogonal and produces identical direct/clustered frame facts', () => {
    const environments = [atmosphere(3, 'sky-a')] as const;
    const fogs = [fog(8)] as const;
    const suns = [sun(4)] as const;
    const direct = selection(environments, fogs, suns, 'direct');
    const clustered = selection(environments, fogs, suns, 'clustered');
    expect(direct.ok).toBe(true);
    expect(clustered.ok).toBe(true);
    if (!direct.ok || !clustered.ok) return;
    expect(direct.value).toEqual(clustered.value);
    expect(direct.value.fog).toEqual(fogs[0]);
    expect(direct.value.signature).toBe(clustered.value.signature);
  });

  it('derives independent Environment and Fog reset signatures', () => {
    const noFog = selection([atmosphere(3, 'sky-a')], [], [sun(4)]);
    const withFog = selection([atmosphere(3, 'sky-a')], [fog(8)], [sun(4)]);
    expect(noFog.ok).toBe(true);
    expect(withFog.ok).toBe(true);
    if (!noFog.ok || !withFog.ok) return;
    expect(noFog.value.environmentSignature).toBe(withFog.value.environmentSignature);
    expect(noFog.value.fogSignature).not.toBe(withFog.value.fogSignature);
    expect(noFog.value.signature).not.toBe(withFog.value.signature);
  });

  it('keeps record assembly on the immutable FramePlan boundary', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../pipeline/standard-pipeline.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('FramePlan');
    expect(source).not.toMatch(/world\.query\s*\(/);
  });
});
