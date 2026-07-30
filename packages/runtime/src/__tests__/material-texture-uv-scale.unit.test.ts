import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  applyMaterialTextureUvScales,
  BUILTIN_USER_REGION_TEXTURE_FIELDS,
  buildPbrMaterialUboPayload,
  materialTextureUvScale,
  userRegionTextureFieldOrder,
} from '@forgeax/engine-render/internal';
import { describe, expect, it } from 'vitest';

describe('material texture UV scale [w37]', () => {
  it('maps a non-aligned BC7 logical edge below padded physical storage', () => {
    const scale = materialTextureUvScale({ width: 2085, height: 1573, format: 'bc7-rgba-unorm' });
    expect(scale).toEqual([2085 / 2088, 1573 / 1576]);
    expect(scale[0]).toBeLessThan(1);
    expect(scale[1]).toBeLessThan(1);
  });

  it('uses identity scale for uncompressed and fallback texture bindings', () => {
    expect(materialTextureUvScale(undefined)).toEqual([1, 1]);
    expect(materialTextureUvScale({ width: 17, height: 9, format: 'rgba8unorm' })).toEqual([1, 1]);
  });

  it('keeps builtin texture slots when compatibility param schemas are empty or numeric-only', () => {
    expect(userRegionTextureFieldOrder([])).toEqual(BUILTIN_USER_REGION_TEXTURE_FIELDS);
    expect(userRegionTextureFieldOrder([{ name: 'baseColor', type: 'color' }])).toEqual(
      BUILTIN_USER_REGION_TEXTURE_FIELDS,
    );
  });

  it('writes each slot set and transform into the builtin PBR payload', () => {
    const payload = buildPbrMaterialUboPayload({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      materialShaderId: 'forgeax::default-standard-pbr',
      textureCoordinates: new Map([
        [
          'baseColorTexture',
          { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 3], rotation: 0.5 } },
        ],
        ['normalTexture', { set: 0, transform: { offset: [0.75, 0.25], scale: [4, 5] } }],
      ]),
    });
    applyMaterialTextureUvScales(
      payload,
      {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 0.5,
        materialShaderId: 'forgeax::default-standard-pbr',
        textureCoordinates: new Map([
          [
            'baseColorTexture',
            { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 3], rotation: 0.5 } },
          ],
          ['normalTexture', { set: 0, transform: { offset: [0.75, 0.25], scale: [4, 5] } }],
        ]),
      },
      new World(),
    );
    const f32 = new Float32Array(payload);
    expect(Array.from(f32.slice(24, 32))).toEqual([0.125, 0.25, 2, 3, 1, 0.5, 1, 1]);
    expect(Array.from(f32.slice(40, 48))).toEqual([0.75, 0.25, 4, 5, 0, 0, 1, 1]);
  });
});
