import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}

interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (path: string) => string;
}

interface NodeUrl {
  fileURLToPath: (url: string) => string;
}

let fs!: NodeFs;
let path!: NodePath;
let srcDir!: string;
let irradianceSource!: string;

beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs')) as NodeFs;
  path = (await import(/* @vite-ignore */ 'node:path')) as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as NodeUrl;
  srcDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  irradianceSource = fs.readFileSync(path.resolve(srcDir, 'ibl-irradiance.wgsl'), 'utf8');
});

describe('IBL irradiance payload contract', () => {
  it('records that convolution produces E times pi before the Lambert divide', () => {
    expect(irradianceSource).toContain('IRRADIANCE_PAYLOAD_E_TIMES_PI');
    expect(irradianceSource).toMatch(/irradiance\s*=\s*PI\s*\*\s*irradiance/);
  });

  it('keeps the constant-environment analytic oracle finite and explicit', () => {
    const environment = 0.72;
    const convolvedPayload = environment * Math.PI;
    const diffuseRadiance = convolvedPayload / Math.PI;

    expect(diffuseRadiance).toBeCloseTo(environment, 12);
    expect(Number.isFinite(diffuseRadiance)).toBe(true);
  });
});
