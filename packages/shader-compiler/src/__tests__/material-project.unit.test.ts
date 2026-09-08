import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectMaterial } from '../material/project.js';
import {
  createMaterialVariantContext,
  lowerMaterialVariantContext,
} from '../material/variant-context.js';

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
    { name: 'baseColor', type: 'color' },
    { name: 'roughness', type: 'f32' },
    { name: 'normalTexture', type: 'texture' },
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

describe('MaterialAsset runtime and module projection', () => {
  it('keeps every material value in the runtime projection', () => {
    const result = projectMaterial(material, {
      material: 'leaf',
      mode: 'development',
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeValues).toEqual(material.values);
    expect(result.value.staticSelection).toMatchObject({
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

  it('characterizes runtime and module-slot projections separately', () => {
    const result = projectMaterial(material, {
      material: 'owner-overlap',
      mode: 'development',
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeValues).toEqual(material.values);
    expect(result.value.staticSelection.moduleSlots).toEqual({ lighting: 'game::pbr' });
  });

  it('accepts only the closed producer-owned variant context', () => {
    const context = createMaterialVariantContext({
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(lowerMaterialVariantContext(context.value)).toEqual({
      STORAGE_BUFFER_AVAILABLE: true,
      WEBGL2_COMPAT: false,
      PER_INSTANCE_REGION: false,
      POINT_SHADOW_AVAILABLE: false,
    });
    expect(
      createMaterialVariantContext({
        backend: 'webgpu',
        capability: 'storage-buffer',
        pipeline: 'forward',
        geometry: 'mesh',
        pass: 'forward',
        profile: 'forgeax-material-wgsl-v1',
        toolchain: 'naga-oil',
        instrumentation: 'none',
        STORAGE_BUFFER_AVAILABLE: false,
      } as never).ok,
    ).toBe(false);
  });
});
