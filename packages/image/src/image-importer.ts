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
// `ctx.subAssets[]`, never minted here. A sub-asset of `kind: 'cube-texture'`
// (HDR equirect IBL) is NOT folded by this importer today (its multi-face
// cook lives on the runtime IBL path); a declared cube GUID with no produced
// POD is surfaced by the runner's `import-produced-no-assets` check rather
// than silently dropped.

import type {
  ImageColorSpace,
  ImportContext,
  ImportedAsset,
  Importer,
  TextureAsset,
} from '@forgeax/engine-types';
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

    const out: ImportedAsset[] = [];
    for (const sub of ctx.subAssets) {
      // Only flat 2D image sub-assets are folded here; cube-texture sub-assets
      // ride the runtime IBL multi-face cook and are intentionally not produced.
      if (sub.kind !== 'image') continue;
      const payload: TextureAsset = {
        kind: 'texture',
        width: dec.width,
        height: dec.height,
        format: 'rgba16float',
        data: f16Bytes,
        colorSpace: 'linear',
        mipmap: false,
      };
      out.push({ guid: sub.guid, kind: 'texture', payload, refs: [] });
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

  const decoded = parseImage(read.value, mime, { colorSpace, mipmap });
  if (!decoded.ok) {
    throw new Error(`imageImporter: parseImage failed: ${decoded.error.code}`);
  }
  const dec = decoded.value;

  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    // Only flat 2D image sub-assets are folded here; cube-texture sub-assets
    // ride the runtime IBL multi-face cook and are intentionally not produced.
    if (sub.kind !== 'image') continue;
    const payload: TextureAsset = {
      kind: 'texture',
      width: dec.width,
      height: dec.height,
      format: colorSpaceToFormat(colorSpace),
      data: dec.bytes,
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
