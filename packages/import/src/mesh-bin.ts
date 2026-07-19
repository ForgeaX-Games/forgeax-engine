// mesh-bin.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache (Fix A)
// feat-20260629-multi-uv-set-support m2-w3: header v2 encode + exit validation
//
// Pack a MeshAsset payload's typed-array fields (vertices, indices) into a
// single deterministic Uint8Array so they can be emitted as a `<guid>.bin`
// sidecar instead of being inlined as JSON number arrays in `.pack.json`. The
// counterpart `unpackMeshBin` lives in `@forgeax/engine-runtime` so the
// runtime can decode without taking a build-time dep.
//
// Bin layout (little-endian, 28-byte header v2):
//   u32 version        -- 2 (hardcoded)
//   u32 uvSetCount     -- number of UV sets (1..8)
//   u32 floatsPerVertex -- explicit stride (12..26)
//   u32 vlen           -- Float32Array element count
//   u32 ilen           -- index element count (0 when no indices)
//   u32 iwidth         -- 2 (Uint16) | 4 (Uint32) | 0 (no indices)
//   u32 jsonlen        -- byte length of trailing UTF-8 JSON metadata
// then vertices, indices, JSON tail (submeshes / aabb / optional skin lens),
// then optional skinIndex (Uint16) bytes, then optional skinWeight (Float32) bytes.
//
// feat-20260611 (w17-b): for skinned MeshAssets, `attributes.skinIndex`
// (Uint16Array) and `attributes.skinWeight` (Float32Array) ride after the
// JSON tail. The JSON metadata carries `skinIndexLen` / `skinWeightLen`
// counts (element count, not byte length) so the decoder can slice the
// trailing region. Back-compat: unskinned meshes omit both keys and emit
// zero trailing skin bytes -- identical to pre-feat byte stream.

interface MeshPayloadInAttributes {
  skinIndex?: unknown;
  skinWeight?: unknown;
  [key: string]: unknown;
}

interface MeshPayloadIn {
  vertices?: unknown;
  indices?: unknown;
  submeshes?: unknown;
  attributes?: MeshPayloadInAttributes | unknown;
  aabb?: unknown;
}

const HEADER_V2_BYTES = 28;

function detectUvSetCount(attrsIn: MeshPayloadInAttributes): number {
  // Check for uv1..uv7 keys; uv (set 0) is always present.
  let maxIdx = 0;
  for (let k = 1; k <= 8; k++) {
    const key = `uv${k}`;
    const v = attrsIn[key];
    if (v instanceof Float32Array || v instanceof Uint16Array || Array.isArray(v)) {
      maxIdx = k;
    }
  }
  return maxIdx + 1; // uv0 = set 0, uv1 = set 1, ...
}

export function packMeshBin(payload: MeshPayloadIn): Uint8Array {
  const verticesIn = payload.vertices;
  const indicesIn = payload.indices;
  const attrsIn = (payload.attributes ?? {}) as MeshPayloadInAttributes;

  let vertices: Float32Array;
  if (verticesIn instanceof Float32Array) {
    vertices = verticesIn;
  } else if (Array.isArray(verticesIn)) {
    vertices = new Float32Array(verticesIn as number[]);
  } else {
    vertices = new Float32Array(0);
  }

  const uvSetCount = detectUvSetCount(attrsIn);

  // Fail Fast: contract validation (encode exit, architecture-principles #5)
  if (uvSetCount < 1 || uvSetCount > 8) {
    throw new Error(
      `[AssetError mesh-bin-contract-violation] expected: uvSetCount in [1,8]; ` +
        `actual: uvSetCount=${uvSetCount}; hint: re-cook the asset via importer`,
    );
  }

  // Derive floatsPerVertex from interleaved buffer.
  let vertexCount = 0;
  let floatsPerVertex = 0;
  if (vertices.length > 0) {
    // Detect stride: base (no skin) = 12 + (uvSetCount - 1) * 2
    //                  base (skin)    = 18 + (uvSetCount - 1) * 2
    const candNoSkin = 12 + (uvSetCount - 1) * 2;
    const candSkin = 18 + (uvSetCount - 1) * 2;
    if (candNoSkin > 0 && vertices.length % candNoSkin === 0) {
      floatsPerVertex = candNoSkin;
      vertexCount = vertices.length / candNoSkin;
    } else if (candSkin > 0 && vertices.length % candSkin === 0) {
      floatsPerVertex = candSkin;
      vertexCount = vertices.length / candSkin;
    }
  }
  // For empty meshes, floatsPerVertex is 0 — decode knows to skip stride check.

  // Fail Fast: floatsPerVertex self-consistency check (encode exit)
  if (vertices.length > 0 && floatsPerVertex === 0) {
    throw new Error(
      `[AssetError mesh-bin-contract-violation] expected: floatsPerVertex in [12,26] ` +
        `matching vertex count; actual: vertices.length=${vertices.length} not divisible ` +
        `by (12 + (uvSetCount-1)*2)=${12 + (uvSetCount - 1) * 2} or ` +
        `(18 + (uvSetCount-1)*2)=${18 + (uvSetCount - 1) * 2}; ` +
        `hint: re-cook the asset via importer`,
    );
  }
  if (vertices.length > 0 && floatsPerVertex * vertexCount * 4 !== vertices.byteLength) {
    throw new Error(
      `[AssetError mesh-bin-contract-violation] expected: floatsPerVertex * vertexCount * 4 ` +
        `== vertices.byteLength; actual: ${floatsPerVertex} * ${vertexCount} * 4 = ` +
        `${floatsPerVertex * vertexCount * 4} != ${vertices.byteLength}; ` +
        `hint: re-cook the asset via importer`,
    );
  }

  let indices: Uint16Array | Uint32Array | undefined;
  if (indicesIn instanceof Uint16Array || indicesIn instanceof Uint32Array) {
    indices = indicesIn;
  } else if (Array.isArray(indicesIn) && (indicesIn as number[]).length > 0) {
    indices =
      vertexCount > 0xffff
        ? new Uint32Array(indicesIn as number[])
        : new Uint16Array(indicesIn as number[]);
  }

  const ilen = indices?.length ?? 0;
  const iwidth = indices === undefined ? 0 : indices.BYTES_PER_ELEMENT;
  const indexBytes = indices?.byteLength ?? 0;

  // feat-20260611 (w17-b): extract optional skin streams
  let skinIndex: Uint16Array | undefined;
  let skinWeight: Float32Array | undefined;
  if (attrsIn.skinIndex instanceof Uint16Array) {
    skinIndex = attrsIn.skinIndex;
  } else if (Array.isArray(attrsIn.skinIndex)) {
    skinIndex = new Uint16Array(attrsIn.skinIndex as number[]);
  }
  if (attrsIn.skinWeight instanceof Float32Array) {
    skinWeight = attrsIn.skinWeight;
  } else if (Array.isArray(attrsIn.skinWeight)) {
    skinWeight = new Float32Array(attrsIn.skinWeight as number[]);
  }
  if (skinIndex === undefined || skinWeight === undefined) {
    skinIndex = undefined;
    skinWeight = undefined;
  }

  const meta: Record<string, unknown> = {};
  if (Array.isArray(payload.submeshes)) meta.submeshes = payload.submeshes;
  if (payload.aabb instanceof Float32Array) {
    meta.aabb = Array.from(payload.aabb);
  } else if (Array.isArray(payload.aabb)) {
    meta.aabb = payload.aabb;
  }
  if (skinIndex !== undefined) {
    meta.skinIndexLen = skinIndex.length;
  }
  if (skinWeight !== undefined) {
    meta.skinWeightLen = skinWeight.length;
  }
  const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
  const jsonBytes = new TextEncoder().encode(metaJson);

  const skinIndexBytes = skinIndex?.byteLength ?? 0;
  const skinWeightBytes = skinWeight?.byteLength ?? 0;

  const total =
    HEADER_V2_BYTES +
    vertices.byteLength +
    indexBytes +
    jsonBytes.byteLength +
    skinIndexBytes +
    skinWeightBytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 2, true); // version = 2
  view.setUint32(4, uvSetCount, true);
  view.setUint32(8, floatsPerVertex, true);
  view.setUint32(12, vertices.length, true); // vlen
  view.setUint32(16, ilen, true);
  view.setUint32(20, iwidth, true);
  view.setUint32(24, jsonBytes.byteLength, true);

  let offset = HEADER_V2_BYTES;
  if (vertices.byteLength > 0) {
    out.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
    offset += vertices.byteLength;
  }
  if (indices !== undefined && indexBytes > 0) {
    out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
    offset += indexBytes;
  }
  if (jsonBytes.byteLength > 0) {
    out.set(jsonBytes, offset);
    offset += jsonBytes.byteLength;
  }
  if (skinIndex !== undefined && skinIndexBytes > 0) {
    out.set(new Uint8Array(skinIndex.buffer, skinIndex.byteOffset, skinIndexBytes), offset);
    offset += skinIndexBytes;
  }
  if (skinWeight !== undefined && skinWeightBytes > 0) {
    out.set(new Uint8Array(skinWeight.buffer, skinWeight.byteOffset, skinWeightBytes), offset);
    offset += skinWeightBytes;
  }

  return out;
}
