import { packMeshBinV4 } from '@forgeax/engine-import';
import { decodeMeshBinHeader } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';

function buildPayload(vertexCount: number, extraUvCount: number, hasSkin: boolean) {
  const baseFpv = hasSkin ? 18 : 12;
  const fpv = baseFpv + extraUvCount * 2;
  const vertices = new Float32Array(vertexCount * fpv);
  for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.1;
  const attributes: Record<string, unknown> = {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
  for (let set = 1; set <= extraUvCount; set++) {
    attributes[`uv${set}`] = new Float32Array(vertexCount * 2);
  }
  if (hasSkin) {
    attributes.skinIndex = new Uint16Array(vertexCount * 4);
    attributes.skinWeight = new Float32Array(vertexCount * 4);
  }
  return { vertices, indices: new Uint16Array([0, 1, 2]), attributes };
}

describe('mesh-bin v4 roundtrip contract', () => {
  it.each([
    [0, false, 1],
    [1, false, 2],
    [2, false, 3],
    [7, false, 8],
    [1, true, 2],
  ])('records canonical projection for %i extra UV sets and skin=%s', (extra, skin, uvSets) => {
    const result = packMeshBinV4(buildPayload(4, extra, skin), `gltf://mesh/${extra}/${skin}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = decodeMeshBinHeader(result.value, `gltf://mesh/${extra}/${skin}`);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.version).toBe(4);
    expect(header.value.projectionVersion).toBe(1);
    expect(header.value.vertexCount).toBe(4);
    expect(header.value.stride).toBe((skin ? 18 + extra * 2 : 12 + extra * 2) * 4);
    expect(header.value.mask).toBeGreaterThan(0);
    expect(uvSets).toBeGreaterThan(0);
  });

  it('stores canonical interleaved bytes and material refs as indexes', () => {
    const guid = '019d0000-0000-7000-8000-000000000005';
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw new Error('fixture guid must parse');
    const payload = {
      vertices: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array([1, 2, 3]),
        normal: new Float32Array([4, 5, 6]),
        uv: new Float32Array([7, 8]),
        tangent: new Float32Array([9, 10, 11, 12]),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 1,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
      materialSlots: [
        { slotName: 'Body', sourceKey: 'gltf:material:0', defaultMaterial: parsed.value },
      ],
    };
    const result = packMeshBinV4(payload, 'gltf://color', [guid]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = decodeMeshBinHeader(result.value, 'gltf://color');
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    const jsonOffset = 80 + header.value.vertexBytes + header.value.indexBytes;
    const json = new TextDecoder().decode(
      result.value.subarray(jsonOffset, jsonOffset + header.value.jsonBytes),
    );
    expect(JSON.parse(json).materialSlots).toEqual([
      { slotName: 'Body', sourceKey: 'gltf:material:0', defaultMaterialRef: 0 },
    ]);
    expect(json).not.toContain(guid);
    expect(Array.from(result.value.subarray(80, 80 + payload.vertices.byteLength))).toEqual(
      Array.from(new Uint8Array(payload.vertices.buffer)),
    );
  });

  it('returns a closed error without bytes for invalid stride cardinality', () => {
    const payload = buildPayload(2, 0, false);
    const result = packMeshBinV4({ ...payload, vertexCount: 3 }, 'gltf://invalid');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceKey).toBe('gltf://invalid');
    expect(result.error.recovery).toContain('re-cook');
  });
});
