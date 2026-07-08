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
// NOTE: @forgeax/engine-codec/encode is the build-time encoder subpath. The
// image-pipeline isolation gate (path d) forbids a STATIC import of it from
// packages/runtime/src (encode is build-time only). This test needs the real
// encoder to mint a Basis KTX2 fixture, so it uses a DYNAMIC import inside the
// pkg-gated beforeAll — build-time-only, never reached in shipped runtime code.
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetCompression, TranscodeCaps } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

const GUID_TEX = 'c0000000-0000-4000-a000-0000626173a1';
const PACK_INDEX_URL = '/basis-catalog-dispatch-pack-index.json';
const BIN_URL = `/ddc/${GUID_TEX}.ktx2`;
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

function wireFetch(rowCompression: AssetCompression | undefined): void {
  globalThis.fetch = ((input: string) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === PACK_INDEX_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              guid: GUID_TEX,
              relativeUrl: BIN_URL,
              kind: 'texture',
              ...(rowCompression !== undefined ? { compression: rowCompression } : {}),
              metadata: {
                kind: 'texture',
                width: W,
                height: H,
                format: 'rgba8unorm-srgb',
                colorSpace: 'srgb',
                mipmap: false,
                // The importer always records the resolved discriminant here;
                // the bug was that the ROW-level field (above) did not mirror it.
                compression: 'basis-etc1s',
              },
            },
          ]),
      });
    }
    // Serve the real Basis KTX2 bytes for the .ktx2 URL.
    return Promise.resolve({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          basisKtx2.buffer.slice(basisKtx2.byteOffset, basisKtx2.byteOffset + basisKtx2.byteLength),
        ),
    });
  }) as unknown as typeof globalThis.fetch;
}

async function loadWith(rowCompression: AssetCompression | undefined) {
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

  it('bug witness: a row missing the basis-* discriminant does NOT load the Basis texture', async () => {
    // Without the resolved basis-* discriminant on the ROW the loader never
    // enters the transcode arm; the real ETC1S (scheme=1) Basis KTX2 cannot come
    // through as a texture. (In the shipped path this surfaces as the codec's
    // `ktx2-unsupported-scheme` reject; the exact error depends on transport
    // gating, so the load-bearing invariant is simply: no successful load.)
    const result = await loadWith('none');
    expect(result.ok).toBe(false);
  });

  it('fix: row compression=basis-etc1s takes the transcode arm and loads', async () => {
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
