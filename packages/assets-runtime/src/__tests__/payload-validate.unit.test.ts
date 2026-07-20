// @forgeax/engine-assets-runtime -- register-time payload validation coverage
// (fix issue #709). Covers validateMeshPayload branch tree, validateTilesetPayload
// R-6 first-error ordering, and inferAtlasExtent.

import type { Asset, MeshAsset, TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { inferAtlasExtent, validateMeshPayload, validateTilesetPayload } from '../payload-validate';

function mesh(over: Partial<MeshAsset>): Asset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(0),
    attributes: {},
    submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list' }],
    ...over,
  } as MeshAsset;
}

describe('validateMeshPayload', () => {
  it('returns null for a non-mesh asset', () => {
    expect(validateMeshPayload({ kind: 'material' } as unknown as Asset)).toBeNull();
  });

  it('returns null for a legal empty mesh (triangle-list, no vertices/indices)', () => {
    expect(validateMeshPayload(mesh({}))).toBeNull();
  });

  it('errors when submeshes is empty', () => {
    const e = validateMeshPayload(mesh({ submeshes: [] }));
    expect(e?.code).toBe('mesh-asset-submeshes-empty');
  });

  it('errors on strip topology without an index buffer', () => {
    const e = validateMeshPayload(
      mesh({
        vertices: new Float32Array(12),
        submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 1, topology: 'triangle-strip' }],
      }),
    );
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { reason: string }).reason).toBe('strip-topology-without-indices');
  });

  it('errors when an empty-geometry submesh uses a non-triangle-list topology', () => {
    const e = validateMeshPayload(
      mesh({
        vertices: new Float32Array(0),
        submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'line-list' }],
      }),
    );
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { reason: string }).reason).toBe('empty-geometry-non-default-topology');
  });

  it('errors when a submesh index range exceeds the index buffer length', () => {
    const e = validateMeshPayload(
      mesh({
        vertices: new Float32Array(36), // 3 verts * 12
        indices: Uint16Array.of(0, 1, 2),
        submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 3, topology: 'triangle-list' }],
      }),
    );
    expect(e?.code).toBe('mesh-submesh-index-range-out-of-bounds');
  });

  it('errors when vertices.length is not divisible by 12 (stride mismatch)', () => {
    const e = validateMeshPayload(
      mesh({
        vertices: new Float32Array(13),
        submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 1, topology: 'triangle-list' }],
      }),
    );
    expect(e?.code).toBe('mesh-vertex-stride-mismatch');
  });

  it('errors when maxIndex + 1 !== vertexCount', () => {
    const e = validateMeshPayload(
      mesh({
        vertices: new Float32Array(24), // 2 vertices
        indices: Uint16Array.of(0, 1, 5), // maxIndex 5 -> expects 6 verts
        submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 2, topology: 'triangle-list' }],
      }),
    );
    expect(e?.code).toBe('mesh-vertex-stride-mismatch');
    expect((e?.detail as { vertexCount: number }).vertexCount).toBe(6);
  });

  it('accepts a well-formed indexed mesh', () => {
    expect(
      validateMeshPayload(
        mesh({
          vertices: new Float32Array(36), // 3 vertices
          indices: Uint16Array.of(0, 1, 2),
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        }),
      ),
    ).toBeNull();
  });

  it('accepts a vertex-only mesh (no indices, skips the maxIndex invariant)', () => {
    expect(
      validateMeshPayload(
        mesh({
          vertices: new Float32Array(24),
          submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 2, topology: 'triangle-list' }],
        }),
      ),
    ).toBeNull();
  });
});

function tileset(over: Partial<TilesetAsset>): TilesetAsset {
  return {
    kind: 'tileset',
    guid: 'ts-guid',
    atlases: [1 as never],
    tileWidth: 16,
    tileHeight: 16,
    columns: 4,
    rows: 4,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
    ...over,
  } as TilesetAsset;
}

describe('validateTilesetPayload', () => {
  it('accepts a well-formed tileset', () => {
    expect(validateTilesetPayload(tileset({}))).toBeNull();
  });

  it('errors when atlases is empty', () => {
    const e = validateTilesetPayload(tileset({ atlases: [] }));
    expect(e?.code).toBe('tileset-tile-entry-malformed');
    expect((e?.detail as { field: string }).field).toBe('atlases');
  });

  it('errors on a negative/zero region rectangle', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: -1, y: 0, width: 16, height: 16 }] }),
    );
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it('errors when a region escapes the supplied atlas extent', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: 0, y: 0, width: 100, height: 16 }] }),
      { atlasWidth: 64, atlasHeight: 64 },
    );
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it('errors on an out-of-range region.atlasIndex', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: 5 }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('atlasIndex');
  });

  it('errors on an out-of-range tile.regionIndex', () => {
    const e = validateTilesetPayload(tileset({ tiles: [{ regionIndex: 9 }] }));
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it('errors on widthCells / heightCells / pivotX / pivotY out of bounds', () => {
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, widthCells: 0 }] }))?.detail,
    ).toMatchObject({ field: 'widthCells' });
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, heightCells: 65 }] }))?.detail,
    ).toMatchObject({ field: 'heightCells' });
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, pivotX: 2 }] }))?.detail,
    ).toMatchObject({ field: 'pivotX' });
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, pivotY: -1 }] }))?.detail,
    ).toMatchObject({ field: 'pivotY' });
  });

  it('accepts a valid rect collider and rejects a malformed one', () => {
    expect(
      validateTilesetPayload(
        tileset({
          tiles: [{ regionIndex: 0, collider: { type: 'rect', rect: [0, 0, 0.5, 0.5] } }],
        }),
      ),
    ).toBeNull();
    const e = validateTilesetPayload(
      tileset({ tiles: [{ regionIndex: 0, collider: { type: 'rect', rect: [0, 0, 2, 2] } }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('collider');
  });

  it('accepts a valid polygon collider and rejects fewer-than-3 points', () => {
    expect(
      validateTilesetPayload(
        tileset({
          tiles: [
            {
              regionIndex: 0,
              collider: {
                type: 'polygon',
                points: [
                  [0, 0],
                  [1, 0],
                  [0, 1],
                ],
              },
            },
          ],
        }),
      ),
    ).toBeNull();
    const e = validateTilesetPayload(
      tileset({ tiles: [{ regionIndex: 0, collider: { type: 'polygon', points: [[0, 0]] } }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('collider');
  });

  it("accepts a 'none' collider", () => {
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, collider: { type: 'none' } }] })),
    ).toBeNull();
  });
});

describe('inferAtlasExtent', () => {
  it('multiplies columns*tileWidth and rows*tileHeight', () => {
    expect(
      inferAtlasExtent(tileset({ columns: 8, tileWidth: 16, rows: 4, tileHeight: 32 })),
    ).toEqual({ atlasWidth: 128, atlasHeight: 128 });
  });
});
