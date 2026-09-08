import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHADER_ROOT = new URL('../', import.meta.url);
const SOURCES = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
] as const;

function source(file: (typeof SOURCES)[number]): string {
  return readFileSync(new URL(file, SHADER_ROOT), 'utf8');
}

describe('M4 vertex-color shader contract', () => {
  it.each(SOURCES)('%s declares the geometry-owned color variant axis', (file) => {
    const text = source(file);
    expect(text).toContain('#pragma variant_axis VERTEX_COLOR_AVAILABLE');
    expect(text).toMatch(
      /#ifdef\s+VERTEX_COLOR_AVAILABLE[\s\S]*?@location\(13\)\s+color\s*:\s*vec4<f32>/,
    );
    expect(text).toMatch(
      /#ifdef\s+VERTEX_COLOR_AVAILABLE[\s\S]*?@location\(14\)\s+color\s*:\s*vec4<f32>/,
    );
    if (file !== 'unlit.wgsl') {
      expect(text).toMatch(/@location\(13\)\s+uv7\s*:\s*vec2<f32>/);
    }
  });

  it.each(
    SOURCES,
  )('%s has an explicit white false variant and does not add a material flag', (file) => {
    const text = source(file);
    expect(text).toMatch(/#else[\s\S]*?vec4<f32>\(1\.0\)/);
    expect(text).not.toMatch(/hasColor|VERTEX_COLOR\s*:/);
    expect(text).not.toMatch(/struct\s+Material\s*\{[^}]*\bcolor\b/s);
  });

  it.each(SOURCES)('%s applies vertex color to linear RGB and all alpha consumers', (file) => {
    const text = source(file);
    expect(text).toMatch(/baseColor\.rgb\s*\*\s*(?:baseSample|texSample)\.rgb\s*\*\s*\w+\.rgb/);
    expect(text).toMatch(/baseColor\.a\s*\*\s*(?:baseSample|texSample)\.a\s*\*\s*\w+\.a/);
    expect(text).toMatch(/alphaCutoff/);
    expect(text).toMatch(/fs_temporal/);
  });

  it('keeps the existing inter-stage uv7 location while reserving color at 14', () => {
    const text = source('default-standard-pbr.wgsl');
    expect(text).toMatch(/@location\(13\)\s+uv7\s*:\s*vec2<f32>/);
    expect(text).toMatch(/@location\(14\)\s+color\s*:\s*vec4<f32>/);
  });
});
