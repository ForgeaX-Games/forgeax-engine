// mesh-bin.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache (Fix A)
//
// Decode a `<guid>.bin` sidecar produced by `packMeshBin` (in
// `@forgeax/engine-import`) back into the typed arrays + metadata the
// runtime mesh loader expects. Mirror of the build-time encoder; both
// halves must agree on the 16-byte header layout.
//
// Bin layout (little-endian, 16-byte header):
//   u32 vlen     -- Float32Array element count
//   u32 ilen     -- index element count
//   u32 iwidth   -- 2 (Uint16) | 4 (Uint32) | 0 (no indices)
//   u32 jsonlen  -- byte length of trailing UTF-8 JSON metadata
// then vertices, indices, JSON tail (submeshes / aabb / optional skin lens),
// then optional skinIndex (Uint16) bytes, then optional skinWeight (Float32) bytes.
//
// feat-20260611 (w17-b): JSON metadata may carry `skinIndexLen` /
// `skinWeightLen` element counts; when present, the corresponding typed
// arrays follow the JSON tail in the binary. Unskinned meshes omit both
// keys and the file ends at the JSON tail (legacy layout, byte-identical
// to pre-feat output).

const HEADER_BYTES = 16;

export interface UnpackedMeshBin {
  vertices: Float32Array;
  indices?: Uint16Array | Uint32Array;
  submeshes?: ReadonlyArray<Record<string, unknown>>;
  aabb?: Float32Array;
  skinIndex?: Uint16Array;
  skinWeight?: Float32Array;
}

export function unpackMeshBin(bytes: Uint8Array): UnpackedMeshBin | undefined {
  if (bytes.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vlen = view.getUint32(0, true);
  const ilen = view.getUint32(4, true);
  const iwidth = view.getUint32(8, true);
  const jsonlen = view.getUint32(12, true);

  const vBytes = vlen * 4;
  const iBytes = ilen * iwidth;
  const minExpected = HEADER_BYTES + vBytes + iBytes + jsonlen;
  if (bytes.byteLength < minExpected) return undefined;

  let offset = HEADER_BYTES;
  // Float32Array view requires 4-byte alignment; copy into a fresh buffer to
  // avoid relying on the source ArrayBuffer being aligned at offset.
  const vertices = new Float32Array(vlen);
  if (vlen > 0) {
    new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength).set(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, vBytes),
    );
    offset += vBytes;
  }

  let indices: Uint16Array | Uint32Array | undefined;
  if (ilen > 0 && iwidth === 4) {
    const u32 = new Uint32Array(ilen);
    new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength).set(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, iBytes),
    );
    indices = u32;
    offset += iBytes;
  } else if (ilen > 0 && iwidth === 2) {
    const u16 = new Uint16Array(ilen);
    new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength).set(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, iBytes),
    );
    indices = u16;
    offset += iBytes;
  }

  let submeshes: ReadonlyArray<Record<string, unknown>> | undefined;
  let aabb: Float32Array | undefined;
  let skinIndexLen = 0;
  let skinWeightLen = 0;
  if (jsonlen > 0) {
    const json = new TextDecoder().decode(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, jsonlen),
    );
    try {
      const parsed = JSON.parse(json) as {
        submeshes?: ReadonlyArray<Record<string, unknown>>;
        aabb?: ReadonlyArray<number>;
        skinIndexLen?: number;
        skinWeightLen?: number;
      };
      if (Array.isArray(parsed.submeshes)) submeshes = parsed.submeshes;
      if (Array.isArray(parsed.aabb)) aabb = new Float32Array(parsed.aabb);
      if (typeof parsed.skinIndexLen === 'number' && parsed.skinIndexLen >= 0) {
        skinIndexLen = parsed.skinIndexLen;
      }
      if (typeof parsed.skinWeightLen === 'number' && parsed.skinWeightLen >= 0) {
        skinWeightLen = parsed.skinWeightLen;
      }
    } catch {
      return undefined;
    }
    offset += jsonlen;
  }

  // feat-20260611 (w17-b): trailing optional skin streams. Each is copied
  // into a fresh buffer (alignment + ownership: keeps the unpacked typed
  // array independent of the source `Uint8Array`'s ArrayBuffer lifetime).
  let skinIndex: Uint16Array | undefined;
  let skinWeight: Float32Array | undefined;
  const skinIndexBytes = skinIndexLen * 2;
  const skinWeightBytes = skinWeightLen * 4;
  const fullExpected = minExpected + skinIndexBytes + skinWeightBytes;
  if (bytes.byteLength < fullExpected) return undefined;
  if (skinIndexLen > 0) {
    const u16 = new Uint16Array(skinIndexLen);
    new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength).set(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, skinIndexBytes),
    );
    skinIndex = u16;
    offset += skinIndexBytes;
  }
  if (skinWeightLen > 0) {
    const f32 = new Float32Array(skinWeightLen);
    new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength).set(
      new Uint8Array(bytes.buffer, bytes.byteOffset + offset, skinWeightBytes),
    );
    skinWeight = f32;
    offset += skinWeightBytes;
  }

  return {
    vertices,
    ...(indices !== undefined ? { indices } : {}),
    ...(submeshes !== undefined ? { submeshes } : {}),
    ...(aabb !== undefined ? { aabb } : {}),
    ...(skinIndex !== undefined ? { skinIndex } : {}),
    ...(skinWeight !== undefined ? { skinWeight } : {}),
  };
}
