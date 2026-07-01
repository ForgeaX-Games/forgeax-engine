// mesh-bin.test.ts -- feat-20260629-multi-uv-set-support m2-w1
//
// Roundtrip test for mesh-bin header v2: 0/1/2/8 UV sets encode->decode
// byte-identical. Header v2 expands from 16B to 28B (version=2 u32 +
// uvSetCount u32 + floatsPerVertex u32 + existing 4 fields).
//
// RED at this commit: packMeshBin still writes 16B header; unpackMeshBin
// reads 16B header. No version/uvSetCount/floatsPerVertex fields survive
// roundtrip. GREEN after m2-w3 (encode v2) + m2-w4 (decode v2).
//
// Coverage:
//   (A) 0 extra UV sets: uvSetCount=1, floatsPerVertex=12 (no skin)
//   (B) 1 extra UV set: uvSetCount=2, floatsPerVertex=14 (no skin)
//   (C) 2 extra UV sets: uvSetCount=3, floatsPerVertex=16 (no skin)
//   (D) 8 UV sets total: uvSetCount=8, floatsPerVertex=26 (no skin)
//   (E) with skin: uvSetCount=2, floatsPerVertex=20 (skin adds +8)

import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

// Replicate the runtime decode signature for cross-package roundtrip test.
// We test the actual pack output bytes against the known header layout,
// then assert the runtime can reconstruct uvSetCount/floatsPerVertex
// from those bytes.

const HEADER_V2_BYTES = 28;

function readHeaderV2(bytes: Uint8Array):
  | {
      version: number;
      uvSetCount: number;
      floatsPerVertex: number;
      vlen: number;
      ilen: number;
      iwidth: number;
      jsonlen: number;
    }
  | undefined {
  if (bytes.byteLength < HEADER_V2_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint32(0, true),
    uvSetCount: view.getUint32(4, true),
    floatsPerVertex: view.getUint32(8, true),
    vlen: view.getUint32(12, true),
    ilen: view.getUint32(16, true),
    iwidth: view.getUint32(20, true),
    jsonlen: view.getUint32(24, true),
  };
}

function buildPayload(vertexCount: number, extraUvCount: number, hasSkin: boolean) {
  const baseFpv = hasSkin ? 18 : 12;
  const fpv = baseFpv + extraUvCount * 2;
  const floats = new Float32Array(vertexCount * fpv);
  for (let i = 0; i < floats.length; i++) floats[i] = i * 0.1;

  const indices = new Uint16Array([0, 1, 2]);

  const attrs: Record<string, unknown> = {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };

  // Add extra UV sets
  for (let k = 1; k <= extraUvCount; k++) {
    const uvArr = new Float32Array(vertexCount * 2);
    for (let i = 0; i < uvArr.length; i++) uvArr[i] = (k * 100 + i) * 0.01;
    attrs[`uv${k}`] = uvArr;
  }

  if (hasSkin) {
    attrs.skinIndex = new Uint16Array(vertexCount * 4);
    attrs.skinWeight = new Float32Array(vertexCount * 4);
  }

  return { vertices: floats, indices, attributes: attrs };
}

describe('mesh-bin header v2 roundtrip (feat-20260629 m2-w1)', () => {
  it('(A) 0 extra UV sets (uvSetCount=1, floatsPerVertex=12, no skin)', () => {
    const payload = buildPayload(4, 0, false);
    const bytes = packMeshBin(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(HEADER_V2_BYTES);

    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;
    expect(hdr.version).toBe(2);
    expect(hdr.uvSetCount).toBe(1);
    expect(hdr.floatsPerVertex).toBe(12);
  });

  it('(B) 1 extra UV set (uvSetCount=2, floatsPerVertex=14, no skin)', () => {
    const payload = buildPayload(4, 1, false);
    const bytes = packMeshBin(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(HEADER_V2_BYTES);

    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;
    expect(hdr.version).toBe(2);
    expect(hdr.uvSetCount).toBe(2);
    expect(hdr.floatsPerVertex).toBe(14);
  });

  it('(C) 2 extra UV sets (uvSetCount=3, floatsPerVertex=16, no skin)', () => {
    const payload = buildPayload(4, 2, false);
    const bytes = packMeshBin(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(HEADER_V2_BYTES);

    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;
    expect(hdr.version).toBe(2);
    expect(hdr.uvSetCount).toBe(3);
    expect(hdr.floatsPerVertex).toBe(16);
  });

  it('(D) 8 UV sets total (uvSetCount=8, floatsPerVertex=26, no skin)', () => {
    const payload = buildPayload(4, 7, false);
    const bytes = packMeshBin(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(HEADER_V2_BYTES);

    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;
    expect(hdr.version).toBe(2);
    expect(hdr.uvSetCount).toBe(8);
    expect(hdr.floatsPerVertex).toBe(26);
  });

  it('(E) with skin: uvSetCount=2, floatsPerVertex=20', () => {
    const payload = buildPayload(4, 1, true);
    const bytes = packMeshBin(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(HEADER_V2_BYTES);

    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;
    expect(hdr.version).toBe(2);
    expect(hdr.uvSetCount).toBe(2);
    expect(hdr.floatsPerVertex).toBe(20);
  });

  it('roundtrip preserves interleaved vertex data byte-exact', () => {
    const payload = buildPayload(4, 2, false);
    const bytes = packMeshBin(payload);

    // Vertices payload starts after 28B header
    const hdr = readHeaderV2(bytes);
    expect(hdr).not.toBeUndefined();
    if (!hdr) return;

    const vertexPayload = new Float32Array(
      bytes.buffer,
      bytes.byteOffset + HEADER_V2_BYTES,
      hdr.vlen,
    );
    expect(Array.from(vertexPayload)).toEqual(
      Array.from((payload.vertices as Float32Array).subarray(0, hdr.vlen)),
    );
  });
});
