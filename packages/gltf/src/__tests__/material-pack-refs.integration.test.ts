import { describe, expect, it } from 'vitest';
import { materialRefsForPack } from '../gltf-importer.js';
import type { GltfDoc, GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material Pack refs', () => {
  it('emits texture and sampler dependencies for every material slot', () => {
    const material = {
      name: 'PackMaterial',
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 1,
      roughnessFactor: 1,
      baseColorTexture: { texture: 0, sampler: 0 },
      metallicRoughnessTexture: { texture: 1, sampler: 1 },
      normalTexture: { texture: 2, sampler: 2 },
      occlusionTexture: { texture: 3, sampler: 3 },
      emissiveTexture: { texture: 4, sampler: 4 },
    } as unknown as GltfMaterialIr;
    const doc = {
      textures: [
        { source: 0, sampler: 0 },
        { source: 1, sampler: 1 },
        { source: 2, sampler: 2 },
        { source: 3, sampler: 3 },
        { source: 4, sampler: 4 },
      ],
    } as unknown as GltfDoc;
    const refs = materialRefsForPack(
      material,
      doc,
      new Map([
        [0, 'texture-0'],
        [1, 'texture-1'],
        [2, 'texture-2'],
        [3, 'texture-3'],
        [4, 'texture-4'],
      ]),
      new Map([
        [0, 'sampler-0'],
        [1, 'sampler-1'],
        [2, 'sampler-2'],
        [3, 'sampler-3'],
        [4, 'sampler-4'],
      ]),
    );
    expect(refs.map((ref) => ref.guid)).toEqual([
      'texture-0',
      'sampler-0',
      'texture-1',
      'sampler-1',
      'texture-2',
      'sampler-2',
      'texture-3',
      'sampler-3',
      'texture-4',
      'sampler-4',
    ]);
  });
});
