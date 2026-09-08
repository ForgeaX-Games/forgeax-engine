import {
  buildMeshAttributeMapForUvSets,
  deriveVertexBufferLayout,
  deriveVertexLayoutProjection,
  deriveVertexLayoutProjectionFromMask,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
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

  it('projects color as host location 13 without moving the existing 0..12 keys', () => {
    const map: VertexAttributeMap = {
      position: new Float32Array([0, 0, 0]),
      normal: new Float32Array([0, 1, 0]),
      uv: new Float32Array([0, 0]),
      tangent: new Float32Array([1, 0, 0, 1]),
      color: new Float32Array([0.25, 0.5, 0.75, 1]),
    };
    const projection = deriveVertexLayoutProjection(map);

    expect(projection.attributes.map((entry) => entry.key)).toEqual([
      'position',
      'normal',
      'uv',
      'tangent',
      'color',
    ]);
    expect(projection.attributes.find((entry) => entry.key === 'color')).toMatchObject({
      shaderLocation: 13,
      offset: 48,
      format: 'float32x4',
    });
    expect(projection.arrayStride).toBe(64);
    expect(projection.mask).toBe(0x200f);
    expect(projection.digest).toBe('vlp-v1-6586e1c9');
  });

  it('keeps digest independent of attribute bytes and changes it when layout changes', () => {
    const a: VertexAttributeMap = {
      position: new Float32Array([0, 0, 0]),
      normal: new Float32Array([0, 1, 0]),
      uv: new Float32Array([0, 0]),
      tangent: new Float32Array([1, 0, 0, 1]),
      color: new Float32Array([1, 0, 0, 1]),
    };
    const b: VertexAttributeMap = { ...a, color: new Float32Array([0, 1, 0, 1]) };
    const c: VertexAttributeMap = { ...a, uv1: new Float32Array([0, 0]) };

    expect(deriveVertexLayoutProjection(a).digest).toBe(deriveVertexLayoutProjection(b).digest);
    expect(deriveVertexLayoutProjection(a).digest).not.toBe(deriveVertexLayoutProjection(c).digest);
  });

  it('reconstructs wire masks through the same canonical projection owner', () => {
    const color = deriveVertexLayoutProjectionFromMask(1 << 13);
    expect(color.ok).toBe(true);
    if (!color.ok) return;
    expect(color.value.attributes.map((entry) => entry.key)).toEqual(['color']);

    const empty = deriveVertexLayoutProjectionFromMask(0);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.detail.reason).toBe('empty');

    const unknown = deriveVertexLayoutProjectionFromMask(1 << 14);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.detail.reason).toBe('unknown-bits');
  });

  it('packs color/no-color using one projection and keeps no-color bytes unchanged', () => {
    const common: VertexAttributeMap = {
      position: new Float32Array([0, 0, 0, 1, 0, 0]),
      normal: new Float32Array([0, 1, 0, 0, 1, 0]),
      uv: new Float32Array([0, 0, 1, 0]),
      tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1]),
    };
    const plain = packInterleavedVertexAttributes(common, 2);
    const colored = packInterleavedVertexAttributes(
      { ...common, color: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]) },
      2,
    );

    expect(plain.ok).toBe(true);
    expect(colored.ok).toBe(true);
    if (!plain.ok || !colored.ok) return;
    expect(plain.value.projection.arrayStride).toBe(48);
    expect(colored.value.projection.arrayStride).toBe(64);
    expect(plain.value.vertices.byteLength).toBe(96);
    expect(colored.value.vertices.byteLength).toBe(128);
    expect(Array.from(colored.value.vertices.slice(12, 16))).toEqual([1, 0, 0, 1]);
    expect(Array.from(colored.value.vertices.slice(28, 32))).toEqual([0, 1, 0, 1]);
  });

  it('rejects non-RGBA, non-finite, and cardinality-mismatched color', () => {
    expect(deriveVertexLayoutProjection({ color: new Float32Array([1, 0, 0]) }).arrayStride).toBe(
      16,
    );
    const nonFinite = packInterleavedVertexAttributes(
      { color: new Float32Array([1, Number.NaN, 0, 1]) },
      1,
    );
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok)
      expect(nonFinite.error.detail).toMatchObject({ reason: 'attribute-non-finite' });
    const mismatched = packInterleavedVertexAttributes({ color: new Float32Array(4) }, 2);
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok)
      expect(mismatched.error.detail).toMatchObject({ reason: 'attribute-cardinality-mismatch' });
    const unaligned = packInterleavedVertexAttributes(
      { color: new ArrayBuffer(3) } as unknown as VertexAttributeMap,
      1,
    );
    expect(unaligned.ok).toBe(false);
    if (!unaligned.ok)
      expect(unaligned.error.detail).toMatchObject({ reason: 'attribute-cardinality-mismatch' });
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
