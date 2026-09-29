import { describe, expect, it } from 'vitest';
import { composeSsrReflection } from '../ssr/composition';
import { buildSsrTracePlan, computeSsrConfidence } from '../ssr/graph';

const baseSpecular = [0.2, 0.3, 0.4] as const;
const screenSpecular = [0.8, 0.7, 0.9] as const;
const fallbackSpecular = [0.1, 0.2, 0.3] as const;

describe('SSR spatial confidence and composition contract', () => {
  it('multiplies every bounded confidence factor without exceeding one', () => {
    const confidence = computeSsrConfidence({
      hit: 0.9,
      thickness: 0.8,
      facing: 0.7,
      edge: 0.6,
      roughness: 0.5,
      temporal: 0.4,
    });
    expect(confidence).toBeCloseTo(0.06048, 12);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('returns zero for non-finite or out-of-range factors instead of hiding invalid input', () => {
    expect(
      computeSsrConfidence({
        hit: 1,
        thickness: 1,
        facing: 1,
        edge: 1,
        roughness: Number.NaN,
        temporal: 1,
      }),
    ).toBe(0);
    expect(
      computeSsrConfidence({
        hit: 1.01,
        thickness: 1,
        facing: 1,
        edge: 1,
        roughness: 1,
        temporal: 1,
      }),
    ).toBe(0);
  });

  it('keeps the Standard lobe unchanged at zero and replaces only its fallback delta at one', () => {
    expect(
      composeSsrReflection({ c: 0, baseSpecular, screenSpecular, fallbackSpecular }),
    ).toMatchObject({ ok: true, value: baseSpecular });
    const full = composeSsrReflection({
      c: 1,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value[0]).toBeCloseTo(0.9, 12);
      expect(full.value[1]).toBeCloseTo(0.8, 12);
      expect(full.value[2]).toBeCloseTo(1, 12);
    }
    const half = composeSsrReflection({
      c: 0.5,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(half.ok).toBe(true);
    if (half.ok) {
      expect(half.value[0]).toBeCloseTo(0.55, 12);
      expect(half.value[1]).toBeCloseTo(0.55, 12);
      expect(half.value[2]).toBeCloseTo(0.7, 12);
    }
  });

  it('keeps trace work bounded and explicitly half-resolution', () => {
    expect(buildSsrTracePlan()).toEqual({
      resolution: 'half',
      coarseSteps: 48,
      refineSteps: 5,
    });
  });
});
