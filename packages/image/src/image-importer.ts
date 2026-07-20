// image-importer.ts - the build-time imageImporter (feat-20260603-asset-import-loader-injection M3 / w23).
//
// The `{ key: 'image', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'image'` to. It absorbs the
// decode logic that previously lived inline in
// `@forgeax/engine-vite-plugin-pack`'s generateBundle (research Finding 4,
// vite-plugin-pack/src/index.ts:354-447): read the source bytes -> parseImage
// -> tight-packed RGBA `DecodedImage` -> a `TextureAsset` POD whose `data`
// column carries the imported RGBA bytes under the meta-declared GUID.
//
// Why image-importer lives in @forgeax/engine-image (D-9): the image domain
// logic stays co-located with the package that already owns parseImage (a
// node-only decoder). Splitting the import into a third package would fracture
// the SSOT. This module is a NODE-ONLY sub-export
// (`@forgeax/engine-image/image-importer`, `default: null` under browser
// conditions) because it statically imports `./parse-image.js` (jpeg-js +
// upng-js). The browser runtime never reaches it: the texture is decoded at
// build time and the runtime loader reads the imported `.bin` (M3 strips the
// runtime decoder edge, AC-15).
//
// importSettings folding (colorSpace / mipmap -> TextureAsset.format) mirrors
// `build-catalog.ts` buildImageMetadata (D-5: `'auto'` -> true / `'none'` ->
// false, `'srgb'` -> 'rgba8unorm-srgb' / `'linear'` -> 'rgba8unorm') so the
// importer and the catalog builder derive the same texture metadata. The
// imported RGBA bytes ride in `TextureAsset.data`; the generateBundle integration (w28)
// extracts that buffer into a hashed `.bin` and folds width/height/format into
// the pack-index row.
//
// GUID import-stable iron law: every produced `ImportedAsset.guid` comes from
// `ctx.subAssets[]`, never minted here. A sub-asset of `kind: 'equirect'`
// (HDR lat-long env map) IS folded by the .hdr arm into an EquirectAsset POD
// (a single 2D rgba16float image); the cube-to-cube IBL projection is a runtime
// GPU pass, not a build-time fold (feat-20260630).

import type {
  EquirectAsset,
  ImageColorSpace,
  ImportContext,
  ImportedAsset,
  Importer,
  TextureAsset,
} from '@forgeax/engine-types';
import type { CompressionMode } from './ktx2-encode.js';
import { encodeTextureToKtx2, resolveEncodeMode } from './ktx2-encode.js';
import { parseImage } from './parse-image.js';

/** Map a source path / mime hint to the parseImage mime literal. */
function mimeFromSource(source: string): 'image/png' | 'image/jpeg' | undefined {
  const lower = source.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return undefined;
}

/** D-5 mipmap token mapping (mirrors build-catalog mipmapTokenToBoolean). */
function mipmapTokenToBoolean(token: unknown): boolean {
  return token === 'auto' || token === true;
}

/** colorSpace -> GPU format literal (mirrors build-catalog colorSpaceToFormat). */
function colorSpaceToFormat(colorSpace: ImageColorSpace): GPUTextureFormat {
  return colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

/**
 * Read the sidecar compressionMode token (D-12 / M3 w18).
 *
 * M3 SEQUENCING CONSTRAINT (plan R-9): the default is hard-wired to `'none'`.
 * An absent / unrecognised token stays `'none'` so existing textures keep the
 * uncompressed `.bin` path -- flipping the default to `'auto'` is M5 (w38).
 */
function compressionModeToken(token: unknown): CompressionMode {
  if (token === 'auto' || token === 'etc1s' || token === 'uastc' || token === 'none') {
    return token;
  }
  return 'none';
}

/**
 * Basis encode arm (D-5 / M3 w18; HDR arm feat-20260707): when the sidecar
 * requests a compressed delivery (mode resolves to non-'none'), encode the
 * decoded pixels into a Basis KTX2 and return those bytes; the catalog
 * `compression` discriminant is set by the vite-plugin-pack wiring (w20).
 * Returns `null` for the 'none' path so the caller keeps the uncompressed
 * `.bin` bytes unchanged (rgba8 for LDR, rgba16float for HDR).
 *
 * `pixels` is tight-packed RGBA: 8-bit RGBA for LDR (`isHdr: false`),
 * rgba16float bytes for HDR (`isHdr: true`). The `isHdr` signal drives both the
 * 'auto' derivation (-> 'uastc-hdr') and the encoder's HDR source path.
 */
async function maybeEncodeTextureBytes(
  pixels: Uint8Array,
  width: number,
  height: number,
  compressionMode: CompressionMode,
  colorSpace: ImageColorSpace,
  isHdr: boolean,
): Promise<Uint8Array | null> {
  if (resolveEncodeMode(compressionMode, { colorSpace, isHdr }) === 'none') {
    return null;
  }
  const result = await encodeTextureToKtx2(pixels, width, height, compressionMode, {
    colorSpace,
    isHdr,
  });
  if (!result.ok) {
    throw new Error(
      `imageImporter: encodeTextureToKtx2 failed (${result.error.code} / ${result.error.mode}): ${result.error.reason}`,
    );
  }
  return result.value.ktx2;
}

async function importImage(ctx: ImportContext): Promise<readonly ImportedAsset[]> {
  const read = await ctx.readSource();
  if (!read.ok) {
    throw new Error(
      `imageImporter: readSource failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );
  }
  const mime = mimeFromSource(ctx.source);

  // --- HDR arm (D-6): .hdr equirect source is decoded via decodeHdr -> f16 ---
  if (mime === undefined && ctx.source.toLowerCase().endsWith('.hdr')) {
    const { decodeHdr } = await import('./hdr-decoder.js');
    const decoded = decodeHdr(read.value);
    if (!decoded.ok) {
      throw new Error(`imageImporter: decodeHdr failed: ${decoded.error.code}`);
    }
    const dec = decoded.value;
    const { halfFloat } = await import('@forgeax/engine-math');
    const f16Bytes = halfFloat.f32ToF16Bytes(
      new Uint8Array(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength),
    );

    // NO block-compression for equirect (feat-20260707 M5 fix). The .hdr arm
    // folds only `kind:'equirect'` sub-assets, and an equirect is ALWAYS an IBL /
    // skybox source: the runtime drives it through equirect-to-cube / irradiance /
    // prefilter / brdf-lut RENDER passes (Skylight.equirect / SkyboxBackground.
    // equirect). A BC6H (block-compressed) texture is sample-only, never a color-
    // renderable render target, so a BC6H equirect breaks cube projection with a
    // "BC6HRGBUfloat is not color renderable" WebGPU error. The equirect must stay
    // uncompressed rgba16float; the catalog `compression` discriminant is forced to
    // 'none' in import-texture.ts (compressionFor), so the two agree. A purely-
    // sampled HDR 2D texture (never folded by this arm) may still take the
    // UASTC-HDR path via the standard image arm below.
    const out: ImportedAsset[] = [];
    for (const sub of ctx.subAssets) {
      // The .hdr arm folds equirect sub-assets only: a single 2D rgba16float
      // image (the lat-long env map) with a disk identity. The cube-to-cube IBL
      // projection is a GPU-side pass driven by the runtime record arm, not a
      // build-time fold (feat-20260630 w5; orchestrator adjudication: equirect
      // produces a build .bin, unlike the retired cube-texture).
      if (sub.kind !== 'equirect') continue;
      const payload: EquirectAsset = {
        kind: 'equirect',
        width: dec.width,
        height: dec.height,
        format: 'rgba16float',
        data: f16Bytes,
        colorSpace: 'linear',
      };
      out.push({ guid: sub.guid, kind: 'equirect', payload, refs: [] });
    }
    return out;
  }

  // --- Standard PNG/JPEG path ---
  if (mime === undefined) {
    throw new Error(
      `imageImporter: unsupported source extension for "${ctx.source}" (expected .png / .jpg / .jpeg / .hdr)`,
    );
  }

  const colorSpace: ImageColorSpace = ctx.importSettings.colorSpace === 'srgb' ? 'srgb' : 'linear';
  const mipmap = mipmapTokenToBoolean(ctx.importSettings.mipmap);
  const compressionMode = compressionModeToken(ctx.importSettings.compressionMode);

  const decoded = parseImage(read.value, mime, { colorSpace, mipmap });
  if (!decoded.ok) {
    throw new Error(`imageImporter: parseImage failed: ${decoded.error.code}`);
  }
  const dec = decoded.value;

  // Basis encode arm (M3 w18): null keeps the uncompressed rgba8 `.bin` path.
  const encodedBytes = await maybeEncodeTextureBytes(
    dec.bytes,
    dec.width,
    dec.height,
    compressionMode,
    colorSpace,
    false,
  );

  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    // Only flat 2D image sub-assets are folded here; cube-texture sub-assets
    // ride the runtime IBL multi-face cook and are intentionally not produced.
    if (sub.kind !== 'texture') continue;
    const payload: TextureAsset = {
      kind: 'texture',
      width: dec.width,
      height: dec.height,
      format: colorSpaceToFormat(colorSpace),
      data: encodedBytes ?? dec.bytes,
      colorSpace,
      mipmap,
    };
    out.push({ guid: sub.guid, kind: 'texture', payload, refs: [] });
  }
  return out;
}

/**
 * The image {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'image'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { imageImporter } from '@forgeax/engine-image/image-importer';
 * const importers = new ImporterRegistry();
 * importers.register(imageImporter);
 * ```
 */
export const imageImporter: Importer = {
  key: 'image',
  import: importImage,
};
