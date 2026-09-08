import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderFiles = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
] as const;

function source(name: (typeof shaderFiles)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

function subtract(a: readonly number[], b: readonly number[]): number[] {
  return a.map((value, index) => value - (b[index] ?? 0));
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

function scale(a: readonly number[], scalar: number): number[] {
  return a.map((value) => value * scalar);
}

describe('Fog orthographic fragment ray contract', () => {
  it('derives the camera-plane origin from the current fragment for every built-in material', () => {
    for (const name of shaderFiles) {
      const shader = source(name);
      expect(shader, name).toContain(
        'worldPos - direction * dot(worldPos - viewParams.cameraPos, direction)',
      );
      expect(shader, name).not.toContain('origin = nearPoint;');
      expect(shader.match(/applySceneFog\(/g)?.length, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps a tilted orthographic camera pixel on its own ray rather than the center ray', () => {
    const camera = [4, 2, -3];
    const direction = [0.3, -0.8, 0.5];
    const length = Math.hypot(...direction);
    const unitDirection = direction.map((value) => value / length);
    const lateral = [1, 0, -0.6];
    const fragment = camera
      .map((value, index) => value + (lateral[index] ?? 0))
      .map((value, index) => value + (unitDirection[index] ?? 0) * 7);
    const origin = subtract(
      fragment,
      scale(unitDirection, dot(subtract(fragment, camera), unitDirection)),
    );

    expect(origin[0]).toBeCloseTo(5, 8);
    expect(origin[1]).toBeCloseTo(2, 8);
    expect(origin[2]).toBeCloseTo(-3.6, 8);
    expect(dot(subtract(fragment, origin), unitDirection)).toBeCloseTo(7, 8);
    expect(dot(subtract(origin, camera), unitDirection)).toBeCloseTo(0, 8);
  });
});
