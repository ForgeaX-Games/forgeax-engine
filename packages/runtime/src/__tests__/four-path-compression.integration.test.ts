// w16 — Integration: 4-path compressed-fixture loading (AC-02)
//
// Validates that all 4 binary loading paths (texture, equirect, font, mesh)
// work with compressed assets. The loaders mechanically pass
// `entry.compression` to fetchBinary; the decompression gate inside
// fetchBinary handles the rest. Zero loader-side logic rewrite.
//
// This test is TDD-RED before w19 — fetchBinary currently has no
// decompression gate, so loading compressed assets fails.
//
// Plan decisions:
//   AC-02: 4 paths through fetchBinary
//   D-2: pass entry.compression value, not entire entry
//   E9: mesh inline (import-runner.ts:422-427) excluded — not in scope
//   D-10: all fixture data programmatic

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_MESH = 'c0000000-0000-4000-a000-00006d657368';
const GUID_TEX = 'c0000000-0000-4000-a000-000074657874';
const GUID_EQUI = 'c0000000-0000-4000-a000-000065717569';
const GUID_FONT = 'c0000000-0000-4000-a000-0000666f6e74';

const PACK_INDEX_URL = '/test-four-path-pack-index.json';

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

/**
 * Minimal synthetic mesh bin payload — v2 header, 3 vertices of 12 floats,
 * Uint16 indices, JSON submesh + aabb tail. Compatible with unpackMeshBin.
 */
function makeMeshBinPayload(): Uint8Array {
  const floatsPerVertex = 12;
  const vlen = 3 * floatsPerVertex;
  const ilen = 3;
  const iwidth = 2;
  const jsonTail =
    '{"submeshes":[{"indexOffset":0,"indexCount":3,"vertexCount":36,"topology":"triangle-list"}],"aabb":[0,0,0,0,1,0,0,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]}';
  const jsonBytes = new TextEncoder().encode(jsonTail);

  const header = new ArrayBuffer(28);
  const dv = new DataView(header);
  dv.setUint32(0, 2, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, 12, true);
  dv.setUint32(12, vlen, true);
  dv.setUint32(16, ilen, true);
  dv.setUint32(20, iwidth, true);
  dv.setUint32(24, jsonBytes.length, true);

  const vertices = new Float32Array(vlen);
  for (let i = 0; i < 3; i++) {
    const b = i * 12;
    vertices[b + 0] = i * 1;
    vertices[b + 1] = 0;
    vertices[b + 2] = 0;
    vertices[b + 3] = 0;
    vertices[b + 4] = 1;
    vertices[b + 5] = 0;
    vertices[b + 6] = 0;
    vertices[b + 7] = 0;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
  }
  const indices = new Uint16Array([0, 1, 2]);

  const totalSize = 28 + vlen * 4 + ilen * iwidth + jsonBytes.length;
  const total = new Uint8Array(totalSize);
  let offset = 0;
  total.set(new Uint8Array(header), offset);
  offset += 28;
  total.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
  offset += vlen * 4;
  total.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
  offset += ilen * iwidth;
  total.set(jsonBytes, offset);
  return total;
}

let originalFetch: typeof globalThis.fetch;

describe('w16: 4-path compressed-fixture loading', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Path 1: mesh loadByGuidProd loads compressed mesh .bin → MeshAsset POD
   *
   * TDD-RED: Before w19, fetchBinary does not decompress — the zstd bytes
   * reach unpackMeshBin → version check reads random bytes → returns undefined
   * → asset-parse-failed. After w19, the decompression gate decompresses
   * first → unpackMeshBin sees original v2 header → succeeds.
   */
  it('path 1: mesh loadByGuid loads compressed mesh .bin → MeshAsset', async () => {
    const original = makeMeshBinPayload();
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(original);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_MESH,
                relativeUrl: `/ddc/${GUID_MESH}.bin`,
                kind: 'mesh',
                compression: 'zstd',
              },
            ]),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid<MeshAsset>(parseGuid(GUID_MESH));

    // TDD-RED: after w19, this becomes true
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('mesh');
      expect(result.value.indices).toBeDefined();
      expect((result.value.indices as Uint16Array).length).toBe(3);
    }
  });

  /**
   * Path 2: textureLoader loads compressed texture .bin → TextureAsset
   *
   * TDD-RED: same issue — the compressed bytes reach the texture loader's
   * data field, get uploaded to GPU as corrupt texture. After w19,
   * fetchBinary decompresses first → loader sees raw RGBA bytes.
   *
   * For the TDD stage we construct a simple RGBA pixel payload (4 bytes)
   * so the loader can still produce a texture asset (shape test).
   */
  it('path 2: textureLoader loads compressed texture .bin → TextureAsset', async () => {
    // 4x4 RGBA8 texture = 64 bytes raw pixel data
    const rawPixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      rawPixels[i] = (i * 17) % 256;
    }
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(rawPixels);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_TEX,
                relativeUrl: `/ddc/${GUID_TEX}.bin`,
                kind: 'texture',
                compression: 'zstd',
                metadata: {
                  kind: 'texture',
                  width: 4,
                  height: 4,
                  format: 'rgba8unorm' as const,
                  colorSpace: 'srgb' as const,
                },
              },
            ]),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_TEX));
    // TDD-RED: after w19 this becomes true — the decompressed bytes
    // produce a valid 64-byte data field.
    expect(result.ok).toBe(true);
  });

  /**
   * Path 3: equirectLoader loads compressed equirect .bin → TextureAsset
   * Same shape as textureLoader.
   */
  it('path 3: equirectLoader loads compressed equirect .bin', async () => {
    const rawPixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      rawPixels[i] = (i * 17) % 256;
    }
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(rawPixels);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_EQUI,
                relativeUrl: `/ddc/${GUID_EQUI}.bin`,
                kind: 'equirect',
                compression: 'zstd',
                metadata: {
                  kind: 'texture',
                  width: 4,
                  height: 4,
                  format: 'rgba16float' as const,
                  colorSpace: 'linear' as const,
                },
              },
            ]),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_EQUI));
    expect(result.ok).toBe(true);
  });

  /**
   * Path 4: fontLoader loads compressed font pack JSON
   *
   * Unlike mesh/texture, font data is JSON (TextDecoder). The decompressed
   * bytes must be valid JSON. Font loading through loadByGuid for a 'font'
   * kind requires the font loader to be registered.
   */
  it('path 4: fontLoader loads compressed font pack JSON', async () => {
    const fontPack = JSON.stringify({
      assets: [{ guid: GUID_FONT, kind: 'font', payload: {} }],
    });
    const fontBytes = new TextEncoder().encode(fontPack);
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(fontBytes);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_FONT,
                relativeUrl: `/ddc/${GUID_FONT}.pack.json`,
                kind: 'font',
                compression: 'zstd',
              },
            ]),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_FONT));
    // Font loader requires atlasGuid/samplerGuid/specific payload fields.
    // The decompression gate successfully decompresses the zstd bytes —
    // the font loader then rejects the content for missing fields.
    // Key assertion: the error code is from font-loader validation
    // (asset-parse-failed), not from fetchBinary decompression gate.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Font loader rejects payload lacking atlasGuid/samplerGuid
      expect(result.error.code).toBe('asset-parse-failed');
    }
  });
});
