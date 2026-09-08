import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const localTemporalShaders = ['unlit.wgsl', 'sprite.wgsl', 'sprite-lit.wgsl'] as const;

const pbrTemporalConsumers = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
] as const;

describe('scene temporal varyings', () => {
  it.each(localTemporalShaders)('%s linearly interpolates both clip authorities', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    expect(source).toMatch(/@interpolate\(linear\) currentClip : vec4<f32>/);
    expect(source).toMatch(/@interpolate\(linear\) previousClip : vec4<f32>/);
  });

  it('keeps PBR UV selection and fragment projection in one module', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'pbr-temporal.wgsl'), 'utf8');
    expect(source).toContain('fn transformedPbrTemporalUv');
    expect(source).toContain('fn projectPbrSceneTemporal');
  });

  it.each(pbrTemporalConsumers)('%s imports the shared PBR temporal authority', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    expect(source).toContain('#import forgeax_pbr::temporal::{projectPbrSceneTemporal}');
    expect(source).toMatch(/@interpolate\(linear\) currentClip : vec4<f32>/);
    expect(source).toMatch(/@interpolate\(linear\) previousClip : vec4<f32>/);
    expect(source).not.toContain('fn transformedTemporalUv');
  });
});
