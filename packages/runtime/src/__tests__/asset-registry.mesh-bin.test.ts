// asset-registry.mesh-bin.test.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache
// M2 / m2-1: regression test for mesh binarize round-trip via .pack.json + .bin
// sidecar (Fix A). RED at this commit (loader cannot read .bin yet); GREEN
// after the implementation commit.
//
// Cases (plan-decisions D-6):
//   (A) binarized new path -- mesh entry payload is the empty sentinel (vertices=[],
//       indices=[], data=Uint8Array(0)); the runtime resolves vertices/indices from
//       a sibling <guid>.bin URL referenced by the catalog row. Asserts
//       round-tripped vertices and indices are byte-equal to the originals.
//   (B) inline fallback (CON-7) -- mesh entry payload carries inline number arrays
//       (legacy pack shape). meshLoader's existing Array.isArray branch must still
//       work. Asserts handle resolves and registered MeshAsset has the inline
//       vertices/indices.
//   (C) empty mesh -- vertices=[], indices=[] sentinel + 16-byte deterministic
//       header (vlen=0, ilen=0, iwidth=0, jsonlen=0). loader returns a mesh with
//       0 vertices and 0 indices, no panic.
//
// Anchors: requirements AC-04 / AC-05 / CON-1 / CON-7;
//          plan-strategy decisions D-1 / D-2 / D-3 / D-6;
//          plan-decisions D-6 (3-case coverage).
//
// Bin layout (D-1 + this test's contract, header v2):
//   header u32 little-endian:
//     [0..4)   version      -- 2
//     [4..8)   uvSetCount   -- 1
//     [8..12)  floatsPerVertex -- 12
//     [12..16) vlen         -- Float32 element count
//     [16..20) ilen         -- index element count
//     [20..24) iwidth       -- 2 (Uint16) or 4 (Uint32); 0 for empty
//     [24..28) jsonlen      -- byte length of trailing UTF-8 JSON metadata
//   then vlen*4 bytes Float32Array vertices,
//   then ilen*iwidth bytes Uint16Array | Uint32Array indices,
//   then jsonlen bytes UTF-8 JSON metadata { submeshes?, attributes?, aabb? }.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// 12 floats per vertex (position vec3 + normal vec3 + uv vec2 + tangent vec4) --
// matches BUILTIN_FLOATS_PER_VERTEX and the meshLoader stride invariant.
const FLOATS_PER_VERTEX = 12;

const MESH_BIN_GUID = '00000000-0000-7000-8000-00006d657368'; // mesh sentinel
const MESH_INLINE_GUID = '00000000-0000-7000-8000-696e6c696e65'; // inline
const MESH_EMPTY_GUID = '00000000-0000-7000-8000-656d70747974'; // empty

function packMeshBinForTest(
  vertices: Float32Array,
  indices: Uint16Array | Uint32Array,
  metaJson: string,
): Uint8Array {
  const iwidth = vertices.length === 0 && indices.length === 0 ? 0 : indices.BYTES_PER_ELEMENT;
  const jsonBytes = new TextEncoder().encode(metaJson);
  const headerBytes = 28; // header v2
  const total = headerBytes + vertices.byteLength + indices.byteLength + jsonBytes.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 2, true); // version = 2
  view.setUint32(4, 1, true); // uvSetCount = 1
  view.setUint32(8, 12, true); // floatsPerVertex = 12
  view.setUint32(12, vertices.length, true);
  view.setUint32(16, indices.length, true);
  view.setUint32(20, iwidth, true);
  view.setUint32(24, jsonBytes.byteLength, true);
  let offset = headerBytes;
  out.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
  offset += vertices.byteLength;
  out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
  offset += indices.byteLength;
  out.set(jsonBytes, offset);
  return out;
}

function makePackIndex(rows: Array<{ guid: string; relativeUrl: string }>) {
  return rows.map((r) => ({
    guid: r.guid,
    relativeUrl: r.relativeUrl,
    kind: 'mesh' as const,
  }));
}

interface FetchRoute {
  json?: unknown;
  bytes?: Uint8Array;
  status?: number;
}

function installFetchMock(routes: Map<string, FetchRoute>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const route = routes.get(url);
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    if (route.status !== undefined && route.status >= 400) {
      return { ok: false, status: route.status } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => route.json,
      arrayBuffer: async () =>
        route.bytes !== undefined
          ? route.bytes.buffer.slice(
              route.bytes.byteOffset,
              route.bytes.byteOffset + route.bytes.byteLength,
            )
          : new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('mesh-bin loader (M2 / m2-1)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('(A) binarized path: vertices/indices reconstructed byte-equal from sibling .bin', async () => {
    // Two-vertex triangle stub (24 floats total = 2 verts * 12F). Vertex count <=
    // 0xffff -> Uint16Array indices.
    const vertices = new Float32Array(FLOATS_PER_VERTEX * 2);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i + 0.5;
    const indices = new Uint16Array([0, 1, 0]);
    const metaJson = JSON.stringify({
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 2, topology: 'triangle-list' }],
      attributes: {},
      aabb: [0, 0, 0, 1, 1, 1],
    });
    const binBytes = packMeshBinForTest(vertices, indices, metaJson);

    const packIndexUrl = '/pack-index.json';
    const binUrl = `/assets/${MESH_BIN_GUID.toLowerCase()}.bin`;
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_BIN_GUID, relativeUrl: binUrl }]) }],
      [binUrl, { bytes: binBytes }],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_BIN_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // D-17: loadByGuid returns the payload directly (registry holds no handles).
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBe(vertices.length);
    for (let i = 0; i < vertices.length; i++) {
      expect(mesh.vertices[i]).toBe(vertices[i]);
    }
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
    expect(mesh.indices?.length).toBe(indices.length);
    if (mesh.indices !== undefined) {
      for (let i = 0; i < indices.length; i++) {
        expect(mesh.indices[i]).toBe(indices[i]);
      }
    }
  });

  it('(B) inline fallback (CON-7): legacy pack with Array.isArray vertices still loads', async () => {
    // Single triangle, 12 floats per vertex, 3 vertices -> 36 floats, 3 indices.
    const verticesArr: number[] = [];
    for (let i = 0; i < FLOATS_PER_VERTEX * 3; i++) verticesArr.push(i + 0.25);
    const indicesArr: number[] = [0, 1, 2];

    const packIndexUrl = '/pack-index.json';
    const packUrl = '/assets/inline.pack.json';
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_INLINE_GUID, relativeUrl: packUrl }]) }],
      [
        packUrl,
        {
          json: {
            schemaVersion: '1.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: MESH_INLINE_GUID,
                kind: 'mesh',
                payload: {
                  vertices: verticesArr,
                  indices: indicesArr,
                  attributes: {},
                },
              },
            ],
          },
        },
      ],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_INLINE_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // D-17: loadByGuid returns the payload directly (registry holds no handles).
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBe(verticesArr.length);
    expect(mesh.vertices[0]).toBe(0.25);
    expect(mesh.indices?.length).toBe(indicesArr.length);
  });

  it('(C) empty mesh: 28-byte header (v2 zero-values) decodes to 0 verts / 0 indices', async () => {
    // Empty .bin: 28-byte header v2 with version=2, all zero payload fields.
    const binBytes = new Uint8Array(28);
    new DataView(binBytes.buffer).setUint32(0, 2, true); // version=2
    new DataView(binBytes.buffer).setUint32(4, 1, true); // uvSetCount=1
    new DataView(binBytes.buffer).setUint32(8, 12, true); // floatsPerVertex=12

    const packIndexUrl = '/pack-index.json';
    const binUrl = `/assets/${MESH_EMPTY_GUID.toLowerCase()}.bin`;
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_EMPTY_GUID, relativeUrl: binUrl }]) }],
      [binUrl, { bytes: binBytes }],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_EMPTY_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // D-17: loadByGuid returns the payload directly (registry holds no handles).
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBe(0);
    expect(mesh.indices === undefined || mesh.indices.length === 0).toBe(true);
  });
});
