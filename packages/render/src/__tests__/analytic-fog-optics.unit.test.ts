import { describe, expect, it } from 'vitest';
import { analyticFogOpacity } from '../environment/analytic-fog';

const fog = { density: 0.01, heightFalloff: 0, maxOpacity: 0.8 };
describe('analytic fog optical depth', () => {
  it('is zero at the eye and follows exponential distance with a bounded opacity', () => {
    expect(analyticFogOpacity(fog, 0, 0, 0)).toBe(0);
    expect(analyticFogOpacity(fog, 0, 0, 100)).toBeCloseTo(0.8 * (1 - Math.exp(-1)), 10);
    expect(analyticFogOpacity(fog, 0, 0, 100000)).toBeCloseTo(0.8, 10);
  });
  it('agrees with numerical height integration for horizontal, rising and descending rays', () => {
    for (const [start, end] of [
      [2, 2],
      [2, 40],
      [40, 2],
      [2, 2.00001],
    ] as const) {
      const settings = { ...fog, heightFalloff: 0.025 };
      const distance = 100,
        steps = 10000;
      let tau = 0;
      for (let i = 0; i < steps; i++) {
        const height = start + (end - start) * ((i + 0.5) / steps);
        tau += (settings.density * Math.exp(-settings.heightFalloff * height) * distance) / steps;
      }
      expect(analyticFogOpacity(settings, start, end, distance)).toBeCloseTo(
        settings.maxOpacity * (1 - Math.exp(-tau)),
        7,
      );
    }
  });
  it('remains finite below the height origin and fades at high elevation', () => {
    const settings = { ...fog, heightFalloff: 0.1 };
    expect(analyticFogOpacity(settings, -10000, -10000, 100)).toBeCloseTo(0.8);
    expect(analyticFogOpacity(settings, 10000, 10000, 100)).toBeLessThan(1e-20);
    expect(analyticFogOpacity({ ...settings, density: 0 }, -10000, 10000, 100)).toBe(0);
  });
});
