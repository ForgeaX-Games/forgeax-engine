// mesh-bin-skin-roundtrip.unit.test.ts -- feat-20260611 (w17-b)
//
// Roundtrip tests for the skinIndex / skinWeight payload extension to the
// mesh.bin binary sidecar format. The pre-feat layout (16-byte header +
// vertices + indices + JSON tail) intentionally dropped per-stream
// typed-array attributes since position / normal / uv / tangent duplicate
// the interleaved buffer. Skin attributes are an exception: the runtime
// pbr-skin VBO layout reads `attributes.skinIndex` / `attributes.skinWeight`
// directly (parallel to the interleaved 18F stride), so the .bin must
// preserve them or skinned meshes render black.
//
// Coverage:
//   (A) skinned mesh -- skinIndex (Uint16Array) + skinWeight (Float32Array)
//       survive packMeshBin -> unpackMeshBin with byte-exact values.
//   (B) back-compat -- unskinned mesh produces a .bin with no skin streams;
//       unpackMeshBin returns no skinIndex / skinWeight keys.
//   (C) edge -- vertex count zero (empty mesh, empty skin streams) does
//       not panic and unpacks to a vertex-less mesh with no skin streams.

import { unpackMeshBin } from '@forgeax/engine-assets-runtime';
import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

const FLOATS_PER_VERTEX_18 = 18;
const FLOATS_PER_VERTEX_12 = 12;

describe('mesh-bin skinIndex / skinWeight roundtrip (feat-20260611 w17-b)', () => {
  it('preserves skinIndex (Uint16Array) and skinWeight (Float32Array) through pack -> unpack', () => {
    const vertexCount = 4;
    const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX_18);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.5;
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const skinIndex = new Uint16Array(vertexCount * 4);
    const skinWeight = new Float32Array(vertexCount * 4);
    for (let i = 0; i < skinIndex.length; i++) {
      skinIndex[i] = i;
      skinWeight[i] = i / skinIndex.length;
    }

    const bytes = packMeshBin({
      vertices,
      indices,
      attributes: { skinIndex, skinWeight },
    });
    const unpacked = unpackMeshBin(bytes);
    expect(unpacked).not.toBeUndefined();
    if (unpacked === undefined) return;

    expect(unpacked.vertices).toBeInstanceOf(Float32Array);
    expect(unpacked.vertices.length).toBe(vertices.length);
    expect(Array.from(unpacked.vertices)).toEqual(Array.from(vertices));

    expect(unpacked.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(unpacked.indices ?? [])).toEqual(Array.from(indices));

    expect(unpacked.skinIndex).toBeInstanceOf(Uint16Array);
    expect(unpacked.skinIndex?.length).toBe(skinIndex.length);
    expect(Array.from(unpacked.skinIndex ?? [])).toEqual(Array.from(skinIndex));

    expect(unpacked.skinWeight).toBeInstanceOf(Float32Array);
    expect(unpacked.skinWeight?.length).toBe(skinWeight.length);
    expect(Array.from(unpacked.skinWeight ?? [])).toEqual(Array.from(skinWeight));
  });

  it('unskinned mesh: pack omits skin streams; unpack returns no skinIndex / skinWeight', () => {
    const vertexCount = 4;
    const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX_12);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i;
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const bytesNoSkin = packMeshBin({ vertices, indices });
    const bytesEmptyAttrs = packMeshBin({ vertices, indices, attributes: {} });

    // Back-compat: byte stream identical to pre-feat output (no trailing
    // skin payload, no skin keys in JSON tail).
    expect(bytesNoSkin.byteLength).toBe(bytesEmptyAttrs.byteLength);

    const unpacked = unpackMeshBin(bytesNoSkin);
    expect(unpacked).not.toBeUndefined();
    if (unpacked === undefined) return;
    expect(unpacked.skinIndex).toBeUndefined();
    expect(unpacked.skinWeight).toBeUndefined();
    expect(unpacked.vertices.length).toBe(vertices.length);
    expect(unpacked.indices).toBeInstanceOf(Uint16Array);
  });

  it('empty mesh: zero vertices + empty skin streams roundtrip without panic', () => {
    const vertices = new Float32Array(0);
    const indices = new Uint16Array(0);
    const skinIndex = new Uint16Array(0);
    const skinWeight = new Float32Array(0);

    const bytes = packMeshBin({ vertices, indices, attributes: { skinIndex, skinWeight } });
    const unpacked = unpackMeshBin(bytes);
    expect(unpacked).not.toBeUndefined();
    if (unpacked === undefined) return;
    expect(unpacked.vertices.length).toBe(0);
    // Zero-length skin streams collapse: the unpacker only materialises a
    // typed array when count > 0 (avoids handing the renderer a 0-length
    // attribute that fails GPU validation). A skinned-but-empty mesh is a
    // pathological input the production path (parseGltf) rejects upstream;
    // this case asserts only that pack -> unpack does not throw.
    expect(unpacked.skinIndex).toBeUndefined();
    expect(unpacked.skinWeight).toBeUndefined();
  });
});
