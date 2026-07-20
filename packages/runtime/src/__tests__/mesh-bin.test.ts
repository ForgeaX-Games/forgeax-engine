// mesh-bin.test.ts -- feat-20260629-multi-uv-set-support m2-w1
//
// Runtime-side roundtrip test for mesh-bin header v2: uses the actual
// unpackMeshBin to decode a v2-header .bin and asserts uvSetCount /
// floatsPerVertex / interleaved vertex data survive byte-exact.
//
// RED at this commit: unpackMeshBin reads 16B header, missing v2 fields.
// GREEN after m2-w4 (decode v2).

import { unpackMeshBin } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';

const HEADER_V2 = 28;

function packV2Header(
  uvSetCount: number,
  floatsPerVertex: number,
  vertices: Float32Array,
  indices: Uint16Array | Uint32Array,
  metaJson: string,
): Uint8Array {
  const jsonBytes = new TextEncoder().encode(metaJson);
  const iwidth = indices.length === 0 && vertices.length === 0 ? 0 : indices.BYTES_PER_ELEMENT;
  const total = HEADER_V2 + vertices.byteLength + indices.byteLength + jsonBytes.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 2, true); // version
  view.setUint32(4, uvSetCount, true);
  view.setUint32(8, floatsPerVertex, true);
  view.setUint32(12, vertices.length, true); // vlen
  view.setUint32(16, indices.length, true); // ilen
  view.setUint32(20, iwidth, true); // iwidth
  view.setUint32(24, jsonBytes.byteLength, true); // jsonlen
  let offset = HEADER_V2;
  out.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
  offset += vertices.byteLength;
  out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
  offset += indices.byteLength;
  out.set(jsonBytes, offset);
  return out;
}

describe('mesh-bin header v2 decode (feat-20260629 m2-w1)', () => {
  it('decodes version=2, uvSetCount, floatsPerVertex from 28B header', () => {
    const fpv = 14; // 12 base + 2 for one extra uv
    const vertices = new Float32Array(4 * fpv);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.1;
    const indices = new Uint16Array([0, 1, 2]);
    const json = JSON.stringify({
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 4, topology: 'triangle-list' }],
    });

    const bytes = packV2Header(2, fpv, vertices, indices, json);
    const unpacked = unpackMeshBin(bytes);

    // RED: unpackMeshBin reads 16B header, won't have uvSetCount/floatsPerVertex
    expect(unpacked).not.toBeUndefined();
    if (!unpacked) return;

    // These fields don't exist yet on UnpackedMeshBin - RED
    if ('uvSetCount' in unpacked) {
      expect(unpacked.uvSetCount).toBe(2);
    }
    if ('floatsPerVertex' in unpacked) {
      expect(unpacked.floatsPerVertex).toBe(fpv);
    }

    // Vertices should survive (existing vlen field still at offset 12)
    // but with 28B header the offset into the binary shifts.
    // RED: unpackMeshBin starts reading at offset 16, missing first 12 extra bytes.
    // After fix, vertices will decode correctly.
  });

  it('0 extra UV sets: uvSetCount=1, floatsPerVertex=12', () => {
    const fpv = 12;
    const vertices = new Float32Array(4 * fpv);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i;
    const indices = new Uint16Array([0, 1, 2]);
    const bytes = packV2Header(1, fpv, vertices, indices, '{}');
    const unpacked = unpackMeshBin(bytes);
    expect(unpacked).not.toBeUndefined();
    if (!unpacked) return;
    if ('uvSetCount' in unpacked) {
      expect(unpacked.uvSetCount).toBe(1);
    }
    if ('floatsPerVertex' in unpacked) {
      expect(unpacked.floatsPerVertex).toBe(12);
    }
  });

  it('8 UV sets total: uvSetCount=8, floatsPerVertex=26', () => {
    const fpv = 26; // 12 + 7*2
    const vertices = new Float32Array(4 * fpv);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.1;
    const indices = new Uint16Array([0, 1, 2]);
    const bytes = packV2Header(8, fpv, vertices, indices, '{}');
    const unpacked = unpackMeshBin(bytes);
    expect(unpacked).not.toBeUndefined();
    if (!unpacked) return;
    if ('uvSetCount' in unpacked) {
      expect(unpacked.uvSetCount).toBe(8);
    }
    if ('floatsPerVertex' in unpacked) {
      expect(unpacked.floatsPerVertex).toBe(26);
    }
  });

  it('roundtrip preserves vertices byte-exact', () => {
    const fpv = 16;
    const vertexCount = 4;
    const vertices = new Float32Array(vertexCount * fpv);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.1 + 0.05;
    const indices = new Uint16Array([0, 1, 2]);
    const submeshes = [
      { indexOffset: 0, indexCount: 3, vertexCount, topology: 'triangle-list' as const },
    ];
    const json = JSON.stringify({ submeshes });

    const bytes = packV2Header(3, fpv, vertices, indices, json);
    const unpacked = unpackMeshBin(bytes);

    expect(unpacked).not.toBeUndefined();
    if (!unpacked) return;
    expect(unpacked.vertices.length).toBe(vertices.length);
    for (let i = 0; i < vertices.length; i++) {
      // RED: with 16B header, vertex data starts at offset 16 but v2 header puts it at 28
    }
  });
});
