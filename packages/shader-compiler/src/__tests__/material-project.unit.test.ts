import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectMaterial } from '../material/project.js';

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'game::paint', moduleSlots: { lighting: 'game::pbr' } },
      renderState: { blend: 'opaque', cull: 'back' },
    },
  ],
  parameters: [
    { name: 'baseColor', type: 'color', static: true },
    { name: 'roughness', type: 'f32' },
    { name: 'normalTexture', type: 'texture', static: true },
  ],
  values: {
    baseColor: [0.8, 0.2, 0.1, 1],
    roughness: 0.35,
    normalTexture: {
      texture: 'normal-guid' as never,
      sampler: 'linear-guid' as never,
      coordinates: { set: 1, transform: { offset: [0.1, 0.2], scale: [2, 2], rotation: 0.5 } },
    },
  },
};

describe('MaterialAsset static and dynamic projection', () => {
  it('keeps runtime values out of static specialization inputs', () => {
    const result = projectMaterial(material, {
      material: 'leaf',
      mode: 'development',
      defines: { QUALITY: 2 },
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeValues).toEqual({ roughness: 0.35 });
    expect(result.value.staticSelection).toMatchObject({
      values: { baseColor: [0.8, 0.2, 0.1, 1] },
      texturePresence: { normalTexture: true },
      textureInputs: {
        normalTexture: {
          coordinates: { set: 1, transform: { rotation: 0.5 } },
        },
      },
      defines: { QUALITY: 2 },
      moduleSlots: { lighting: 'game::pbr' },
      pipelineState: { blend: 'opaque', cull: 'back' },
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });
  });

  it('returns a structured missing-cook error in production mode', () => {
    const result = projectMaterial(material, { material: 'leaf', mode: 'production' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    {
      expect(result.error.code).toBe('material-specialization-not-cooked');
      const detail = result.error.detail as {
        material: string;
        staticSelection: readonly unknown[];
      };
      expect(detail.material).toBe('leaf');
      expect(detail.staticSelection.length).toBeGreaterThan(0);
    }
  });
});
