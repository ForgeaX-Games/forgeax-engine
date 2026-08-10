import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material bridge values', () => {
  it('preserves all four base-color channels for factor and texture composition', () => {
    const factor = [0.5, 0.75, 0.25, 0.4] as const;
    const material = toMaterialAsset({
      baseColorFactor: factor,
      metallicFactor: 0.5,
      roughnessFactor: 0.7,
      baseColorTexture: { texture: 0 },
    } as unknown as GltfMaterialIr);

    expect(material.values).toMatchObject({ baseColor: factor });
    expect(material.values).not.toHaveProperty('baseColorAlpha');
    expect(material.values).not.toHaveProperty('textureAlphaFactor');
  });

  it.each([
    ['default', undefined, 0.5],
    ['explicit', 0.73, 0.73],
    ['zero', 0, 0],
    ['one', 1, 1],
  ] as const)('projects MASK %s cutoff into the material contract', (_name, authored, expected) => {
    const material = toMaterialAsset({
      baseColorFactor: [1, 1, 1, 0.5],
      metallicFactor: 0,
      roughnessFactor: 1,
      alphaMode: 'MASK',
      ...(authored === undefined ? {} : { alphaCutoff: authored }),
    } as unknown as GltfMaterialIr);

    expect(material.values?.alphaCutoff).toBe(expected);
  });

  it('projects five structured texture slots into standard-root values', () => {
    const material = toMaterialAsset(
      {
        baseColorFactor: [0.8, 0.2, 0.1, 1],
        metallicFactor: 0.5,
        roughnessFactor: 0.7,
        baseColorTexture: { texture: 0, sampler: 10, texCoord: 1 },
        metallicRoughnessTexture: { texture: 1, sampler: 11, texCoord: 2 },
        normalTexture: { texture: 2, sampler: 12, texCoord: 3, scale: 0.6 },
        occlusionTexture: { texture: 3, sampler: 13, texCoord: 4, strength: 0.8 },
        emissiveTexture: { texture: 4, sampler: 14, texCoord: 5 },
      } as unknown as GltfMaterialIr,
      {
        textureHandles: new Map([
          [0, 100],
          [1, 101],
          [2, 102],
          [3, 103],
          [4, 104],
        ]) as unknown as ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>,
        samplerHandles: new Map([
          [10, 200],
          [11, 201],
          [12, 202],
          [13, 203],
          [14, 204],
        ]) as unknown as ReadonlyMap<number, Handle<'SamplerAsset', 'shared'>>,
      },
    );

    expect(material.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
    expect(material.colorSpace).toBe('linear');
    expect(material.values).toMatchObject({
      baseColor: [0.8, 0.2, 0.1, 1],
      metallic: 0.5,
      roughness: 0.7,
      baseColorTexture: { texture: 100, sampler: 200, coordinates: { set: 1 } },
      metallicRoughnessTexture: { texture: 101, sampler: 201, coordinates: { set: 2 } },
      normalTexture: { texture: 102, sampler: 202, coordinates: { set: 3 }, normalScale: 0.6 },
      occlusionTexture: {
        texture: 103,
        sampler: 203,
        coordinates: { set: 4 },
        occlusionStrength: 0.8,
      },
      emissiveTexture: { texture: 104, sampler: 204, coordinates: { set: 5 } },
    });
  });
});
