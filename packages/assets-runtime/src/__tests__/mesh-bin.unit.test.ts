import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  MESH_BIN_HEADER_V4_BYTES,
  type MeshBinHeaderV4,
  writeMeshBinHeader,
} from '@forgeax/engine-pack';
import { describe, expect, it } from 'vitest';
import { unpackMeshBinV4 } from '../loaders/mesh-bin';

function makeArtifact(
  options: {
    readonly attributes?: Record<string, Float32Array | Uint16Array>;
    readonly vertices?: Float32Array;
    readonly indices?: Uint16Array | Uint32Array;
    readonly json?: Record<string, unknown>;
    readonly version?: number;
    readonly trailingBytes?: number;
  } = {},
): Uint8Array {
  const attributes = options.attributes ?? {
    position: new Float32Array(3),
    normal: new Float32Array(3),
    uv: new Float32Array(2),
    tangent: new Float32Array(4),
  };
  const projection = deriveVertexLayoutProjection(attributes);
  const vertices = options.vertices ?? new Float32Array(projection.arrayStride / 4);
  const indices = options.indices;
  const json = new TextEncoder().encode(
    JSON.stringify(
      options.json ?? {
        submeshes: [{ indexOffset: 0, indexCount: indices?.length ?? 0, materialSlot: 0 }],
        materialSlots: [{ slotName: 'Default' }],
      },
    ),
  );
  const indexWidth = indices === undefined ? 0 : indices.BYTES_PER_ELEMENT;
  const header: MeshBinHeaderV4 = {
    version: 4,
    projectionVersion: projection.schemaVersion,
    mask: projection.mask,
    digest: projection.digest,
    stride: projection.arrayStride,
    vertexCount: vertices.byteLength / projection.arrayStride,
    vertexBytes: vertices.byteLength,
    indexCount: indices?.length ?? 0,
    indexWidth: indexWidth as 0 | 2 | 4,
    indexBytes: indices?.byteLength ?? 0,
    jsonBytes: json.byteLength,
  };
  const bytes = new Uint8Array(
    MESH_BIN_HEADER_V4_BYTES + vertices.byteLength + (indices?.byteLength ?? 0) + json.byteLength,
  );
  writeMeshBinHeader(header, bytes);
  if (options.version !== undefined) new DataView(bytes.buffer).setUint32(0, options.version, true);
  let offset = MESH_BIN_HEADER_V4_BYTES;
  bytes.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
  offset += vertices.byteLength;
  if (indices !== undefined) {
    bytes.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
    offset += indices.byteLength;
  }
  bytes.set(json, offset);
  if (options.trailingBytes !== undefined)
    return new Uint8Array([...bytes, ...new Uint8Array(options.trailingBytes)]);
  return bytes;
}

describe('unpackMeshBin v4 happy path', () => {
  it('decodes vertices, indices, submeshes, and aabb metadata', () => {
    const vertices = new Float32Array(12);
    vertices[0] = 1.5;
    const out = unpackMeshBinV4(
      makeArtifact({
        vertices,
        indices: Uint16Array.of(0, 1, 0),
        json: {
          submeshes: [{ indexOffset: 0, indexCount: 3, materialSlot: 0 }],
          materialSlots: [{ slotName: 'Default' }],
          aabb: [0, 0, 0, 1, 1, 1],
        },
      }),
      'mesh/happy',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.vertices[0]).toBeCloseTo(1.5);
    expect(out.value.indices).toBeInstanceOf(Uint16Array);
    expect(out.value.submeshes).toHaveLength(1);
    expect(Array.from(out.value.aabb ?? [])).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('decodes Uint32 indices and reconstructs projection attributes', () => {
    const out = unpackMeshBinV4(
      makeArtifact({
        indices: Uint32Array.of(0, 0, 0),
        attributes: {
          position: new Float32Array(3),
          normal: new Float32Array(3),
          uv: new Float32Array(2),
          tangent: new Float32Array(4),
          color: new Float32Array(4),
        },
      }),
      'mesh/uint32',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.indices).toBeInstanceOf(Uint32Array);
    expect(out.value.attributes.color).toBeInstanceOf(Float32Array);
  });

  it('decodes skin streams from the canonical interleaved projection', () => {
    const out = unpackMeshBinV4(
      makeArtifact({
        attributes: {
          position: new Float32Array(3),
          normal: new Float32Array(3),
          uv: new Float32Array(2),
          tangent: new Float32Array(4),
          skinIndex: new Uint16Array(4),
          skinWeight: new Float32Array(4),
        },
      }),
      'mesh/skin',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(out.value.attributes.skinWeight).toBeInstanceOf(Float32Array);
  });
});

describe('unpackMeshBin v4 fail-closed', () => {
  it('rejects legacy versions and truncated headers', () => {
    expect(unpackMeshBinV4(makeArtifact({ version: 3 }), 'mesh/legacy').ok).toBe(false);
    expect(unpackMeshBinV4(new Uint8Array(10), 'mesh/truncated').ok).toBe(false);
  });

  it('rejects trailing bytes and malformed metadata with recovery facts', () => {
    const trailing = unpackMeshBinV4(makeArtifact({ trailingBytes: 1 }), 'mesh/trailing');
    expect(trailing.ok).toBe(false);
    const malformed = unpackMeshBinV4(
      makeArtifact({ json: { submeshes: [], materialSlots: [] } }),
      'mesh/metadata',
    );
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error.sourceKey).toBe('mesh/metadata');
    expect(malformed.error.recovery).toContain('re-cook');
  });
});
