// mesh-bin.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache (Fix A)
//
// Pack a MeshAsset payload's typed-array fields (vertices, indices) into a
// single deterministic Uint8Array so they can be emitted as a `<guid>.bin`
// sidecar instead of being inlined as JSON number arrays in `.pack.json`. The
// counterpart `unpackMeshBin` lives in `@forgeax/engine-runtime` so the
// runtime can decode without taking a build-time dep.
//
// Bin layout (little-endian, 16-byte header):
//   u32 vlen     -- Float32Array element count
//   u32 ilen     -- index element count (0 when no indices)
//   u32 iwidth   -- 2 (Uint16) | 4 (Uint32) | 0 (no indices)
//   u32 jsonlen  -- byte length of trailing UTF-8 JSON metadata
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
}

interface MeshPayloadIn {
  vertices?: unknown;
  indices?: unknown;
  submeshes?: unknown;
  attributes?: MeshPayloadInAttributes | unknown;
  aabb?: unknown;
}

const HEADER_BYTES = 16;

export function packMeshBin(payload: MeshPayloadIn): Uint8Array {
  const verticesIn = payload.vertices;
  const indicesIn = payload.indices;

  let vertices: Float32Array;
  if (verticesIn instanceof Float32Array) {
    vertices = verticesIn;
  } else if (Array.isArray(verticesIn)) {
    vertices = new Float32Array(verticesIn as number[]);
  } else {
    vertices = new Float32Array(0);
  }

  let indices: Uint16Array | Uint32Array | undefined;
  if (indicesIn instanceof Uint16Array || indicesIn instanceof Uint32Array) {
    indices = indicesIn;
  } else if (Array.isArray(indicesIn) && (indicesIn as number[]).length > 0) {
    // Pick width from vertex count (matches meshIrToMeshAsset).
    const FLOATS_PER_VERTEX = 12;
    const vertexCount = vertices.length / FLOATS_PER_VERTEX;
    indices =
      vertexCount > 0xffff
        ? new Uint32Array(indicesIn as number[])
        : new Uint16Array(indicesIn as number[]);
  }

  const ilen = indices?.length ?? 0;
  const iwidth = indices === undefined ? 0 : indices.BYTES_PER_ELEMENT;
  const indexBytes = indices?.byteLength ?? 0;

  // feat-20260611 (w17-b): extract optional skin streams from
  // `payload.attributes`. Both must be present together to be emitted; a
  // single-sided skin attr is a parse-time error caught by parse-gltf
  // (gltf-skin-attr-asymmetric) and never reaches packMeshBin in the
  // production path -- but we defensively skip emit if only one side is
  // typed. Lengths must match (4 weights per vertex / 4 joints per vertex).
  const attrsIn = (payload.attributes ?? {}) as MeshPayloadInAttributes;
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
  // Both required for emit; unmatched -> drop both (safer than half-payload).
  if (skinIndex === undefined || skinWeight === undefined) {
    skinIndex = undefined;
    skinWeight = undefined;
  }

  // bug-20260610: only the small structural fields (submeshes + aabb) ride
  // along in the JSON tail. Per-stream typed arrays for position / normal /
  // uv / tangent are intentionally dropped (they duplicate the interleaved
  // bytes already in `vertices`). feat-20260611 carves out an exception for
  // skinIndex / skinWeight -- these typed arrays are NOT duplicated in the
  // interleaved buffer (skin slots in the 18F stride are a parallel write,
  // and render-system reads `attributes.skinIndex` directly via
  // `deriveVertexBufferLayout` for the pbr-skin VBO layout). Drop them and
  // the fox-shaped mesh renders black even with shader auto-route correct.
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
    HEADER_BYTES +
    vertices.byteLength +
    indexBytes +
    jsonBytes.byteLength +
    skinIndexBytes +
    skinWeightBytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, vertices.length, true);
  view.setUint32(4, ilen, true);
  view.setUint32(8, iwidth, true);
  view.setUint32(12, jsonBytes.byteLength, true);

  let offset = HEADER_BYTES;
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
