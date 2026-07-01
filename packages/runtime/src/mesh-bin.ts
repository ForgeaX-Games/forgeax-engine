// mesh-bin.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache (Fix A)
// feat-20260629-multi-uv-set-support m2-w4: header v2 decode + entry validation
//
// Decode a `<guid>.bin` sidecar produced by `packMeshBin` (in
// `@forgeax/engine-import`) back into the typed arrays + metadata the
// runtime mesh loader expects. Mirror of the build-time encoder; both
// halves must agree on the 28-byte header v2 layout.
//
// Bin layout (little-endian, 28-byte header v2):
//   u32 version        -- must be 2
//   u32 uvSetCount     -- number of UV sets (1..8)
//   u32 floatsPerVertex -- explicit stride (12..26)
//   u32 vlen           -- Float32Array element count
//   u32 ilen           -- index element count
//   u32 iwidth         -- 2 (Uint16) | 4 (Uint32) | 0 (no indices)
//   u32 jsonlen        -- byte length of trailing UTF-8 JSON metadata
// then vertices, indices, JSON tail (submeshes / aabb / optional skin lens),
// then optional skinIndex (Uint16) bytes, then optional skinWeight (Float32) bytes.
//
// feat-20260611 (w17-b): JSON metadata may carry `skinIndexLen` /
// `skinWeightLen` element counts; when present, the corresponding typed
// arrays follow the JSON tail in the binary. Unskinned meshes omit both
// keys and the file ends at the JSON tail (legacy layout, byte-identical
// to pre-feat output).

const HEADER_V2_BYTES = 28;

export interface UnpackedMeshBin {
  vertices: Float32Array;
  indices?: Uint16Array | Uint32Array;
  submeshes?: ReadonlyArray<Record<string, unknown>>;
  aabb?: Float32Array;
  skinIndex?: Uint16Array;
  skinWeight?: Float32Array;
  /** feat-20260629-multi-uv-set-support: number of UV sets (1..8) from header v2 */
  uvSetCount?: number;
  /** feat-20260629-multi-uv-set-support: explicit stride from header v2 */
  floatsPerVertex?: number;
}

export function unpackMeshBin(bytes: Uint8Array): UnpackedMeshBin | undefined {
  if (bytes.byteLength < HEADER_V2_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true);
  const uvSetCount = view.getUint32(4, true);
  const floatsPerVertex = view.getUint32(8, true);

  // Fail Fast: decode entry contract validation (architecture-principles #5)
  if (version !== 2) return undefined; // unknown version
  if (uvSetCount < 1 || uvSetCount > 8) return undefined; // uvSetCount out of range

  const vlen = view.getUint32(12, true);
  const ilen = view.getUint32(16, true);
  const iwidth = view.getUint32(20, true);
  const jsonlen = view.getUint32(24, true);

  // Self-consistency: vlen must be divisible by floatsPerVertex
  if (floatsPerVertex > 0 && vlen % floatsPerVertex !== 0) return undefined;
  // Self-consistency: floatsPerVertex must be in valid range for given uvSetCount.
  // Allow floatsPerVertex=0 only when vlen=0 (empty mesh, no vertex payload to validate).
  const expectedFpvNoSkin = 12 + (uvSetCount - 1) * 2;
  const expectedFpvSkin = 18 + (uvSetCount - 1) * 2;
  if (vlen > 0) {
    if (floatsPerVertex !== expectedFpvNoSkin && floatsPerVertex !== expectedFpvSkin) {
      return undefined;
    }
  }

  const vBytes = vlen * 4;
  const iBytes = ilen * iwidth;
  const minExpected = HEADER_V2_BYTES + vBytes + iBytes + jsonlen;
  if (bytes.byteLength < minExpected) return undefined;

  let offset = HEADER_V2_BYTES;
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
    uvSetCount,
    floatsPerVertex,
  };
}
