// @forgeax/engine-assets-runtime -- unpackMeshBin coverage (fix issue #709).
// Builds 28-byte header v2 `.bin` buffers matching the encoder contract and
// exercises the happy path plus every fail-fast return-undefined branch.

import { describe, expect, it } from 'vitest';
import { unpackMeshBin } from '../mesh-bin';

const HEADER_V2_BYTES = 28;

interface BinParts {
  version?: number;
  uvSetCount?: number;
  floatsPerVertex?: number;
  vertices?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  json?: Record<string, unknown> | string;
  skinIndex?: Uint16Array;
  skinWeight?: Float32Array;
  /** Truncate the produced buffer to this many bytes (to test short-buffer guards). */
  truncateTo?: number;
}

function buildBin(parts: BinParts): Uint8Array {
  const vertices = parts.vertices ?? new Float32Array(0);
  const indices = parts.indices;
  const iwidth = indices instanceof Uint32Array ? 4 : indices instanceof Uint16Array ? 2 : 0;
  const ilen = indices?.length ?? 0;
  const jsonStr =
    parts.json === undefined
      ? ''
      : typeof parts.json === 'string'
        ? parts.json
        : JSON.stringify(parts.json);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  const skinIndexBytes = (parts.skinIndex?.length ?? 0) * 2;
  const skinWeightBytes = (parts.skinWeight?.length ?? 0) * 4;

  const total =
    HEADER_V2_BYTES +
    vertices.byteLength +
    ilen * iwidth +
    jsonBytes.byteLength +
    skinIndexBytes +
    skinWeightBytes;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, parts.version ?? 2, true);
  view.setUint32(4, parts.uvSetCount ?? 1, true);
  view.setUint32(8, parts.floatsPerVertex ?? 12, true);
  view.setUint32(12, vertices.length, true);
  view.setUint32(16, ilen, true);
  view.setUint32(20, iwidth, true);
  view.setUint32(24, jsonBytes.byteLength, true);

  let off = HEADER_V2_BYTES;
  buf.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), off);
  off += vertices.byteLength;
  if (indices) {
    buf.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), off);
    off += indices.byteLength;
  }
  buf.set(jsonBytes, off);
  off += jsonBytes.byteLength;
  if (parts.skinIndex) {
    buf.set(new Uint8Array(parts.skinIndex.buffer, 0, skinIndexBytes), off);
    off += skinIndexBytes;
  }
  if (parts.skinWeight) {
    buf.set(new Uint8Array(parts.skinWeight.buffer, 0, skinWeightBytes), off);
  }

  return parts.truncateTo === undefined ? buf : buf.slice(0, parts.truncateTo);
}

describe('unpackMeshBin happy path', () => {
  it('decodes vertices + Uint16 indices + submeshes/aabb JSON tail', () => {
    const vertices = new Float32Array(24); // 2 vertices * 12 floats
    vertices[0] = 1.5;
    const indices = Uint16Array.of(0, 1, 0);
    const out = unpackMeshBin(
      buildBin({
        vertices,
        indices,
        json: { submeshes: [{ indexOffset: 0, indexCount: 3 }], aabb: [0, 0, 0, 1, 1, 1] },
      }),
    );
    expect(out).toBeDefined();
    expect(out?.vertices).toBeInstanceOf(Float32Array);
    expect(out?.vertices[0]).toBeCloseTo(1.5);
    expect(out?.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(out?.indices as Uint16Array)).toEqual([0, 1, 0]);
    expect(out?.submeshes).toHaveLength(1);
    expect(Array.from(out?.aabb as Float32Array)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(out?.uvSetCount).toBe(1);
    expect(out?.floatsPerVertex).toBe(12);
  });

  it('decodes Uint32 indices (iwidth 4)', () => {
    const out = unpackMeshBin(
      buildBin({ vertices: new Float32Array(12), indices: Uint32Array.of(0, 0, 0), json: {} }),
    );
    expect(out?.indices).toBeInstanceOf(Uint32Array);
  });

  it('decodes a skinned mesh (18 floats/vertex + skinIndex + skinWeight tails)', () => {
    const out = unpackMeshBin(
      buildBin({
        floatsPerVertex: 18,
        vertices: new Float32Array(18),
        json: { skinIndexLen: 4, skinWeightLen: 4 },
        skinIndex: Uint16Array.of(0, 1, 2, 3),
        skinWeight: Float32Array.of(0.25, 0.25, 0.25, 0.25),
      }),
    );
    expect(out?.skinIndex).toBeInstanceOf(Uint16Array);
    expect(out?.skinWeight).toBeInstanceOf(Float32Array);
    expect(Array.from(out?.skinIndex as Uint16Array)).toEqual([0, 1, 2, 3]);
  });

  it('decodes an empty mesh (floatsPerVertex 0, vlen 0)', () => {
    const out = unpackMeshBin(buildBin({ floatsPerVertex: 0, vertices: new Float32Array(0) }));
    expect(out).toBeDefined();
    expect(out?.vertices.length).toBe(0);
  });

  it('supports multi-UV stride (uvSetCount 2 -> 14 floats/vertex)', () => {
    const out = unpackMeshBin(
      buildBin({ uvSetCount: 2, floatsPerVertex: 14, vertices: new Float32Array(14) }),
    );
    expect(out?.uvSetCount).toBe(2);
    expect(out?.floatsPerVertex).toBe(14);
  });
});

describe('unpackMeshBin fail-fast (returns undefined)', () => {
  it('buffer shorter than the 28-byte header', () => {
    expect(unpackMeshBin(new Uint8Array(10))).toBeUndefined();
  });

  it('unknown header version', () => {
    expect(unpackMeshBin(buildBin({ version: 3, vertices: new Float32Array(12) }))).toBeUndefined();
  });

  it('uvSetCount out of [1, 8] range', () => {
    expect(unpackMeshBin(buildBin({ uvSetCount: 0 }))).toBeUndefined();
    expect(unpackMeshBin(buildBin({ uvSetCount: 9 }))).toBeUndefined();
  });

  it('vlen not divisible by floatsPerVertex', () => {
    // floatsPerVertex 12, vlen 13 -> 13 % 12 !== 0
    expect(unpackMeshBin(buildBin({ vertices: new Float32Array(13) }))).toBeUndefined();
  });

  it('floatsPerVertex inconsistent with uvSetCount', () => {
    // uvSetCount 1 expects 12 (no skin) or 18 (skin); 16 matches neither
    expect(
      unpackMeshBin(
        buildBin({ uvSetCount: 1, floatsPerVertex: 16, vertices: new Float32Array(16) }),
      ),
    ).toBeUndefined();
  });

  it('declared payload longer than the actual buffer', () => {
    const good = buildBin({ vertices: new Float32Array(12), indices: Uint16Array.of(0) });
    expect(unpackMeshBin(good.slice(0, good.length - 4))).toBeUndefined();
  });

  it('malformed JSON tail', () => {
    expect(
      unpackMeshBin(buildBin({ vertices: new Float32Array(12), json: '{not valid json' })),
    ).toBeUndefined();
  });

  it('skin tails declared in JSON but truncated in the buffer', () => {
    const full = buildBin({
      floatsPerVertex: 18,
      vertices: new Float32Array(18),
      json: { skinIndexLen: 4, skinWeightLen: 4 },
      skinIndex: Uint16Array.of(0, 1, 2, 3),
      skinWeight: Float32Array.of(1, 1, 1, 1),
    });
    expect(unpackMeshBin(full.slice(0, full.length - 8))).toBeUndefined();
  });
});
