import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fogWgsl = readFileSync(fileURLToPath(new URL('../fog.wgsl', import.meta.url)), 'utf8');
const commonWgsl = readFileSync(fileURLToPath(new URL('../common.wgsl', import.meta.url)), 'utf8');

interface FogCase {
  readonly name: string;
  readonly originY: number;
  readonly directionY: number;
  readonly distance: number;
  readonly density: number;
  readonly heightFalloff: number;
  readonly maxOpacity: number;
  readonly expectedOpacity: number;
}

function opticalDepth(input: FogCase): number {
  const rho0 = input.density * Math.exp(-input.heightFalloff * input.originY);
  const q = input.heightFalloff * input.directionY;
  if (Math.abs(q) < 1e-6) return rho0 * input.distance;
  return (rho0 * (1 - Math.exp(-q * input.distance))) / q;
}

function fogOpacity(input: FogCase): number {
  return input.maxOpacity * (1 - Math.exp(-Math.max(opticalDepth(input), 0)));
}

const cases: readonly FogCase[] = [
  {
    name: 'uniform',
    originY: 0,
    directionY: 0,
    distance: 10,
    density: 0.1,
    heightFalloff: 0,
    maxOpacity: 1,
    expectedOpacity: 0.6321205588,
  },
  {
    name: 'horizontal-height',
    originY: 2,
    directionY: 0,
    distance: 5,
    density: 0.2,
    heightFalloff: 0.5,
    maxOpacity: 1,
    expectedOpacity: 0.3077993724,
  },
  {
    name: 'upward-height',
    originY: 0,
    directionY: 1,
    distance: 4,
    density: 0.2,
    heightFalloff: 0.5,
    maxOpacity: 1,
    expectedOpacity: 0.2923926197,
  },
  {
    name: 'downward-height',
    originY: 0,
    directionY: -1,
    distance: 4,
    density: 0.2,
    heightFalloff: 0.5,
    maxOpacity: 1,
    expectedOpacity: 0.9223561116,
  },
  {
    name: 'small-q-limit',
    originY: 1.5,
    directionY: 0.5,
    distance: 7,
    density: 0.03,
    heightFalloff: 1e-12,
    maxOpacity: 1,
    expectedOpacity: 0.189415754,
  },
  {
    name: 'max-opacity',
    originY: 0,
    directionY: 0,
    distance: 10,
    density: 0.5,
    heightFalloff: 0,
    maxOpacity: 0.25,
    expectedOpacity: 0.2483155133,
  },
];

describe('Fog optical-depth CPU oracle (M2)', () => {
  it('reports case-wise expected, observed, delta, and verdict', () => {
    const report = cases.map((input) => {
      const observed = fogOpacity(input);
      const delta = Math.abs(observed - input.expectedOpacity);
      return {
        name: input.name,
        expected: input.expectedOpacity,
        observed,
        delta,
        verdict: delta <= 1e-9,
      };
    });
    for (const result of report) {
      expect(result.verdict, `${result.name}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('keeps HDR scene radiance and alpha while mixing in linear space', () => {
    const scene = [2, 4, 8, 0.37] as const;
    const fog = [0.5, 1.5, 3] as const;
    const opacity = 0.25;
    const mixed = scene.map((value, index) =>
      index === 3 ? value : (1 - opacity) * value + opacity * (fog[index] ?? 0),
    );
    expect(mixed).toEqual([1.625, 3.375, 6.75, 0.37]);
  });

  it('has one shared Fog WGSL owner with finite ray and height inputs', () => {
    expect(fogWgsl).toContain('#define_import_path forgeax_view::fog');
    expect(fogWgsl).toContain('#import forgeax_view::common::{FogViewParams, FogRay}');
    expect(fogWgsl).toMatch(/fn apply_fog\s*\(/);
    expect((fogWgsl.match(/fn apply_fog\s*\(/g) ?? []).length).toBe(1);
    expect(fogWgsl).toContain('FOG_Q_EPSILON');
    expect(fogWgsl).toContain('FOG_EXP_LIMIT');
    expect(fogWgsl).toContain('max(tau, 0.0)');
    expect(fogWgsl).toContain('color.a');
    expect(commonWgsl).toMatch(/fog\s*:\s*FogViewParams/);
  });
});
