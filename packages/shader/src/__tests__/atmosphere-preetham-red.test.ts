import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}

interface NodePath {
  dirname(path: string): string;
  resolve(...parts: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

let source = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node:fs')) as unknown as NodeFs;
  const path = (await import(/* @vite-ignore */ 'node:path')) as unknown as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as unknown as NodeUrl;
  const shaderPath = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    'atmosphere-preetham.wgsl',
  );
  expect(fs.existsSync(shaderPath)).toBe(true);
  source = fs.readFileSync(shaderPath, 'utf8');
});

describe('Preetham artifact contract (red gate)', () => {
  it('pins one algorithm revision and independent Y/x/y coefficient tables', () => {
    expect(source).toContain('PREETHAM_ALGORITHM_REVISION');
    expect(source).toContain('PREETHAM_PEREZ_Y_COEFFICIENTS');
    expect(source).toContain('PREETHAM_PEREZ_X_COEFFICIENTS');
    expect(source).toContain('PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS');
    expect(source).toContain('1999');
  });

  it('owns Yxy to linear-sRGB conversion and below-horizon clamp', () => {
    expect(source).toContain('preetham_yxy_to_linear_srgb');
    expect(source).toContain('preetham_sky_radiance');
    expect(source).toMatch(/max\([^\n]*\.y[^\n]*0\.0/);
    expect(source).toContain('finite');
  });

  it('does not create a second evaluator or inject a disc into the cube', () => {
    expect(source.match(/fn\s+preetham_sky_radiance\b/g) ?? []).toHaveLength(1);
    expect(source).not.toContain('sun_disc');
  });
});
