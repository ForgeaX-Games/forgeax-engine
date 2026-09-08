import { beforeAll, describe, expect, it } from 'vitest';

let source = '';

beforeAll(async () => {
  const fs = await import(/* @vite-ignore */ 'node:fs');
  const path = await import(/* @vite-ignore */ 'node:path');
  const url = await import(/* @vite-ignore */ 'node:url');
  source = fs.readFileSync(
    path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'atmosphere-background.wgsl',
    ),
    'utf8',
  );
});

describe('analytic atmosphere background ray and disc', () => {
  it('reconstructs a camera-relative world ray before comparing the Sun direction', () => {
    expect(source).toMatch(/world\.xyz\s*\/\s*world\.w\s*-\s*view\.cameraPos/);
    expect(source).toContain('atmosphere_sun_disc_radiance');
    expect(source).toMatch(/dot\(normalize\(viewDirection\),\s*normalize\(sunDirection\)\)/);
  });

  it('keeps the Sun disc out of the generated cube and IBL path', () => {
    expect(source).toContain('sunDiscEnabled');
    expect(source).toContain('atmosphere.sunDirection.y > 0.0');
    expect(source).toContain('solidAngle');
    expect(source).toContain('textureSample(sky, skySampler, cubeDirection)');
    expect(source).toContain('vec3<f32>(direction.x, -direction.y, direction.z)');
  });
});
