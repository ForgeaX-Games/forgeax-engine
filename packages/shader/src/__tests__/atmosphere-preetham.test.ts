import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync(path: string, encoding: string): string;
}

interface NodePath {
  dirname(path: string): string;
  resolve(...parts: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string): string;
}

interface CompilerModule {
  compileShader(
    source: string,
    options: {
      readonly id: string;
      readonly imports?: Readonly<Record<string, string>>;
    },
  ): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string } }>;
}

let source = '';
let producerSource = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node:fs')) as unknown as NodeFs;
  const path = (await import(/* @vite-ignore */ 'node:path')) as unknown as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as unknown as NodeUrl;
  source = fs.readFileSync(
    path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'atmosphere-preetham.wgsl',
    ),
    'utf8',
  );
  producerSource = fs.readFileSync(
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'atmosphere-cubemap.wgsl'),
    'utf8',
  );
});

function finite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function yxyToLinearSrgb(Y: number, x: number, y: number): [number, number, number] {
  const safeY = Math.max(y, 1e-5);
  const X = (Y * x) / safeY;
  const Z = (Y * Math.max(1 - x - y, 0)) / safeY;
  return [
    Math.max(3.2406 * X - 1.5372 * Y - 0.4986 * Z, 0),
    Math.max(-0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0),
    Math.max(0.0557 * X - 0.204 * Y + 1.057 * Z, 0),
  ].map((channel) => Math.min(channel, 65504)) as [number, number, number];
}

describe('Preetham analytic sky artifact', () => {
  it('is one pinned build-time evaluator with a separate background disc', () => {
    expect(source.match(/fn\s+preetham_sky_radiance\b/g) ?? []).toHaveLength(1);
    expect(source).toContain('PREETHAM_ALGORITHM_REVISION');
    expect(source).toContain('PREETHAM_PEREZ_Y_COEFFICIENTS');
    expect(source).toContain('PREETHAM_PEREZ_X_COEFFICIENTS');
    expect(source).toContain('PREETHAM_PEREZ_SMALL_Y_COEFFICIENTS');
    expect(source).not.toContain('const PREETHAM_PEREZ_COEFFICIENTS');
    expect(source).toContain('preetham_zenith_yxy');
    expect(source).toContain('preetham_relative_perez');
    expect(source).toContain('preetham_yxy_to_linear_srgb');
    expect(source).toContain('preetham_finite_guard');
    expect(source).toContain('let daylightWeight = smoothstep(-0.12, 0.02, sun.y)');
  });

  it('keeps the Y/x/y component order and luminance in the XYZ conversion', () => {
    expect(source).toMatch(/let\s+Y\s*=\s*max\(yxy\.x/);
    expect(source).toMatch(/let\s+x\s*=\s*clamp\(yxy\.y/);
    expect(source).toMatch(/let\s+y\s*=\s*clamp\(yxy\.z/);
    expect(yxyToLinearSrgb(1, 1 / 3, 1 / 3)).toEqual(
      expect.arrayContaining([
        expect.closeTo(1.2048, 4),
        expect.closeTo(0.9484, 4),
        expect.closeTo(0.9087, 4),
      ]),
    );
    const low = yxyToLinearSrgb(0.5, 0.28, 0.3);
    const high = yxyToLinearSrgb(1, 0.28, 0.3);
    expect(high[0] / low[0]).toBeCloseTo(2, 5);
    expect(high[1] / low[1]).toBeCloseTo(2, 5);
    expect(high[2] / low[2]).toBeCloseTo(2, 5);
  });

  it('passes the build-time Naga validation path', async () => {
    const compiler = (await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    )) as unknown as CompilerModule;
    const result = await compiler.compileShader(source, {
      id: 'forgeax_environment::preetham',
    });
    expect(result.ok).toBe(true);
  });

  it('validates the sole cubemap producer caller through composition', async () => {
    const compiler = (await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    )) as unknown as CompilerModule;
    const result = await compiler.compileShader(producerSource, {
      id: 'forgeax_environment::cubemap',
      imports: { 'forgeax_environment::preetham': source },
    });
    expect(result.ok).toBe(true);
    expect(producerSource.match(/preetham_sky_radiance\s*\(/g) ?? []).toHaveLength(1);
    expect(producerSource).not.toMatch(/-input\.direction\.y/);
  });

  it.each([
    ['horizon', 4.2, 0.3, 0.32],
    ['zenith', 2.1, 0.25, 0.27],
    ['extreme-low-lux', 0, 0.25, 0.27],
  ])('%s Yxy probe remains finite', (_name, Y, x, y) => {
    expect(yxyToLinearSrgb(Y, x, y).every(finite)).toBe(true);
  });

  it('scales sky radiance with illuminance without changing direct-light ownership', () => {
    const low = yxyToLinearSrgb(2, 0.28, 0.3);
    const high = yxyToLinearSrgb(4, 0.28, 0.3);
    expect(high[1] / low[1]).toBeCloseTo(2, 5);
    expect(source).not.toContain('sun_disc');
  });
});
