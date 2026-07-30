import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

describe('glTF KHR_texture_transform per-slot parsing', () => {
  it('keeps transform and texCoord override attached to each texture slot', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        textures: [
          { source: 0, sampler: 0 },
          { source: 1, sampler: 1 },
        ],
        materials: [
          {
            pbrMetallicRoughness: {
              baseColorTexture: {
                index: 0,
                texCoord: 0,
                extensions: {
                  KHR_texture_transform: {
                    texCoord: 6,
                    offset: [0.25, 0.5],
                    rotation: 0.75,
                    scale: [2, 3],
                  },
                },
              },
              metallicRoughnessTexture: {
                index: 1,
                texCoord: 1,
                extensions: {
                  KHR_texture_transform: {
                    texCoord: 7,
                    offset: [-0.25, -0.5],
                    rotation: -0.75,
                    scale: [4, 5],
                  },
                },
              },
            },
          },
        ],
      },
      noopLoader,
      '/texture-transform.gltf',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const material = result.value.materials[0] as unknown as Record<
      string,
      { texCoord?: number; transform?: Record<string, unknown> } | undefined
    >;
    if (
      material.baseColorTexture === undefined ||
      material.metallicRoughnessTexture === undefined
    ) {
      throw new Error('expected textured material slots');
    }
    expect(material.baseColorTexture.texCoord).toBe(6);
    expect(material.baseColorTexture.transform).toEqual({
      offset: [0.25, 0.5],
      rotation: 0.75,
      scale: [2, 3],
    });
    expect(material.metallicRoughnessTexture.texCoord).toBe(7);
    expect(material.metallicRoughnessTexture.transform).toEqual({
      offset: [-0.25, -0.5],
      rotation: -0.75,
      scale: [4, 5],
    });
  });
});
