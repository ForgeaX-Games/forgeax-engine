// basis-catalog-dispatch.integration.test.ts -- feat-20260707 M6 fix regression.
//
// End-to-end witness for the catalog round-trip bug: the pack-index ROW must
// carry the resolved `compression: 'basis-*'` discriminant so the runtime
// `loadTextureAsset` dispatches its transcode arm. Before the fix, the build /
// dev texture arms stamped the row with the STRATEGY_TABLE 'none' default (the
// resolved basis-* lived only in `metadata.compression`), so loadTextureAsset
// missed the transcode arm and the scheme=1 (BasisLZ / ETC1S) KTX2 fell through
// to `ktx2LevelsToRGBA`, which rejects it with `ktx2-unsupported-scheme`.
//
// This test uses the REAL encoder + REAL transcoder WASM (no mocks) so it
// exercises the exact scheme=1 payload the pipeline ships:
//   (bug witness) row compression='none'         -> scheme=1 reject (load fails)
//   (fix)         row compression='basis-etc1s'  -> transcode arm succeeds
//
// pkg/ (encoder + transcoder glue) is a gitignored emcc artefact (AC-12); CI's
// build-artifacts job builds it. Skip when absent (contributor without emsdk).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
// NOTE: @forgeax/engine-codec/encode is the build-time encoder subpath. The
// image-pipeline isolation gate (path d) forbids a STATIC import of it from
// packages/runtime/src (encode is build-time only). This test needs the real
// encoder to mint a Basis KTX2 fixture, so it uses a DYNAMIC import inside the
// pkg-gated beforeAll — build-time-only, never reached in shipped runtime code.
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { TranscodeCaps } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

const GUID_TEX = 'c0000000-0000-4000-a000-0000626173a1';
const PACK_INDEX_URL = '/basis-catalog-dispatch-pack-index.json';
const PACK_URL = `/ddc/${GUID_TEX}.pack.json`;
const W = 16;
const H = 16;
const NO_CAPS: TranscodeCaps = { bc: false, etc2: false, astc: false };

let basisKtx2: Uint8Array;
let originalFetch: typeof globalThis.fetch;

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

// Build a deterministic RGBA gradient and encode it to a real ETC1S Basis KTX2
// (scheme=1). The exact payload the vite-plugin-pack image arm ships for a
// compressionMode:'auto' sRGB texture.
beforeAll(async () => {
  if (!pkgBuilt) return;
  const { basisEncode } = await import('@forgeax/engine-codec/encode');
  const pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      pixels[i] = (x * 16) & 0xff;
      pixels[i + 1] = (y * 16) & 0xff;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  }
  const enc = await basisEncode(pixels, {
    mode: 'etc1s',
    width: W,
    height: H,
    srgb: true,
    perceptual: true,
    uastcSupercompression: false,
    mipGen: false,
  });
  if (!enc.ok) throw new Error(`basisEncode failed: ${enc.error.code}`);
  basisKtx2 = enc.value;
});

function wireFetch(rowCompression: 'basis-etc1s' | undefined): void {
  globalThis.fetch = ((input: string) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === PACK_INDEX_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              guid: GUID_TEX,
              packageUrl: PACK_URL,
              kind: 'texture',
            },
          ]),
      });
    }
    if (url === PACK_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID_TEX,
                kind: 'texture',
                payload: {
                  width: W,
                  height: H,
                  format: 'rgba8unorm-srgb',
                  colorSpace: 'srgb',
                },
                refs: [],
                artifacts: {
                  body: {
                    path: `${GUID_TEX}.ktx2`,
                    mediaType: 'image/ktx2',
                    ...(rowCompression === undefined
                      ? {}
                      : { assetCodec: { name: 'basis', profile: 'etc1s' } }),
                  },
                },
              },
            ],
          }),
      });
    }
    // Serve the real Basis KTX2 bytes for the artifact URL.
    return Promise.resolve({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          basisKtx2.buffer.slice(basisKtx2.byteOffset, basisKtx2.byteOffset + basisKtx2.byteLength),
        ),
    });
  }) as unknown as typeof globalThis.fetch;
}

async function loadWith(rowCompression: 'basis-etc1s' | undefined) {
  wireFetch(rowCompression);
  const reg = new AssetRegistry(makeMockShaderRegistry());
  reg.configurePackIndex(PACK_INDEX_URL);
  reg.setTranscodeCaps(NO_CAPS);
  return reg.loadByGuid(parseGuid(GUID_TEX));
}

describe.skipIf(!pkgBuilt)('Basis catalog dispatch round-trip (M6 fix)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads a Basis texture when the artifact has no optional codec hint', async () => {
    // Catalog v2 carries package navigation only. The optional codec hint is
    // owned by the artifact descriptor, so a valid KTX2 artifact remains
    // loadable when that hint is absent from the package row.
    const result = await loadWith(undefined);
    expect(result.ok).toBe(true);
  });

  it('artifact codec=basis-etc1s takes the transcode arm and loads', async () => {
    const result = await loadWith('basis-etc1s');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`load failed: ${result.error.code}`);
    const tex = result.value as { kind: string; width: number; height: number; format: string };
    expect(tex.kind).toBe('texture');
    expect(tex.width).toBe(W);
    expect(tex.height).toBe(H);
    // NO_CAPS -> the transcode arm degrades to the uncompressed sRGB fallback
    // (section 8 P3), never a scheme=1 reject.
    expect(tex.format).toBe('rgba8unorm-srgb');
  });
});
