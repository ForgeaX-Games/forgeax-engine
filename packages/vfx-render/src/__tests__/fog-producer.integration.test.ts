import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderNames = ['billboard', 'mesh', 'ribbon', 'trail', 'beam'] as const;

function shaderSource(name: (typeof shaderNames)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../shaders/${name}.wgsl`, import.meta.url)), 'utf8');
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe('VFX Fog producer contract', () => {
  it('requires one shared Fog call with a world-space ray for every topology', () => {
    for (const name of shaderNames) {
      const source = shaderSource(name);
      expect(source, name).toMatch(
        /#import\s+forgeax_view::common::\{[^}]*\bFogViewParams\b[^}]*\bFogRay\b[^}]*\}/,
      );
      expect(source, name).toMatch(/#import\s+forgeax_view::fog::\{[^}]*\bapply_fog\b[^}]*\}/);
      expect(count(source, /\bapply_fog\s*\(/g), name).toBe(1);
      expect(count(source, /\bFogRay\s*\(/g), name).toBe(1);
      expect(source, name).toMatch(/world[_A-Za-z]*position|worldPosition/);
      expect(source, name).toMatch(/ray[_A-Za-z]*distance|distance/);
      expect(source, name).toMatch(/\.a\b|alpha/);
      expect(source, name).not.toMatch(/texture_3d|raymarch/i);
    }
  });

  it('keeps VFX coverage on the current graphics feature lane', () => {
    const feature = readFileSync(
      fileURLToPath(new URL('../feature/gpu-particle-feature.ts', import.meta.url)),
      'utf8',
    );
    const camera = readFileSync(
      fileURLToPath(new URL('../feature/camera.ts', import.meta.url)),
      'utf8',
    );
    expect(feature).toContain('requiredCapabilities');
    expect(feature).toContain('identity: IDENTITY');
    expect(feature).not.toMatch(/fog(?:History|Texture|Registry)/i);
    expect(feature).toContain('worldCenter');
    expect(camera).toContain('position');
    expect(camera).toContain('viewProjection');
  });

  it('keeps billboard scene-depth soft-particle alpha before Fog mixing', () => {
    const billboard = shaderSource('billboard');
    const depthLoad = billboard.indexOf('textureLoad(scene_depth');
    const softParticleCall = billboard.indexOf('softParticle(input.position');
    const fogCall = billboard.indexOf('apply_fog(');

    expect(depthLoad).toBeGreaterThanOrEqual(0);
    expect(softParticleCall).toBeGreaterThan(depthLoad);
    expect(fogCall).toBeGreaterThan(softParticleCall);
    expect(billboard).toContain('input.color.a * edge, input.fade_distance');
  });
});
