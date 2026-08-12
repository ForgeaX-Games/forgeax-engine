import { buildMeshAttributeMapForUvSets, deriveVertexBufferLayout } from '@forgeax/engine-geometry';
import type { VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const makeBuffer = (): Float32Array => new Float32Array(0);

function makeCompleteAttributeMap(): VertexAttributeMap {
  return {
    position: makeBuffer(),
    normal: makeBuffer(),
    uv: makeBuffer(),
    tangent: makeBuffer(),
    skinIndex: new Uint16Array(0).buffer,
    skinWeight: makeBuffer(),
    uv1: makeBuffer(),
    uv2: makeBuffer(),
    uv3: makeBuffer(),
    uv4: makeBuffer(),
    uv5: makeBuffer(),
    uv6: makeBuffer(),
    uv7: makeBuffer(),
  };
}

describe('vertex attribute layout owner', () => {
  it('derives the complete 13-key layout from the format owner', () => {
    expect(deriveVertexBufferLayout(makeCompleteAttributeMap())).toEqual([
      {
        arrayStride: 128,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' },
          { shaderLocation: 3, offset: 32, format: 'float32x4' },
          { shaderLocation: 4, offset: 48, format: 'uint16x4' },
          { shaderLocation: 5, offset: 56, format: 'float32x4' },
          { shaderLocation: 6, offset: 72, format: 'float32x2' },
          { shaderLocation: 7, offset: 80, format: 'float32x2' },
          { shaderLocation: 8, offset: 88, format: 'float32x2' },
          { shaderLocation: 9, offset: 96, format: 'float32x2' },
          { shaderLocation: 10, offset: 104, format: 'float32x2' },
          { shaderLocation: 11, offset: 112, format: 'float32x2' },
          { shaderLocation: 12, offset: 120, format: 'float32x2' },
        ],
      },
    ]);
  });

  it('derives multi-UV keys and clamps missing shader sets to the last mesh set', () => {
    const map = buildMeshAttributeMapForUvSets(4);

    expect(Object.keys(map)).toEqual(['position', 'normal', 'uv', 'tangent', 'uv1', 'uv2', 'uv3']);
    expect(deriveVertexBufferLayout(map, { shaderUvSetCount: 6 })).toEqual([
      {
        arrayStride: 72,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' },
          { shaderLocation: 3, offset: 32, format: 'float32x4' },
          { shaderLocation: 6, offset: 48, format: 'float32x2' },
          { shaderLocation: 7, offset: 56, format: 'float32x2' },
          { shaderLocation: 8, offset: 64, format: 'float32x2' },
          { shaderLocation: 9, offset: 64, format: 'float32x2' },
          { shaderLocation: 10, offset: 64, format: 'float32x2' },
        ],
      },
    ]);
  });
});
