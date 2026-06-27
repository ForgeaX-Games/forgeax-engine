// import-texture.ts -- shared import fn for `kind: 'texture'` pack-index rows
// (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4).
//
// gap-3: the build `generateBundle` import arm (index.ts) and the dev
// POST /__import path both need the same "decode source -> imported bytes ->
// folded ImageMetadata" step. This module is that one SSOT (plan-strategy
// D-1). Both call sites import `importTextureEntry`; each then does its own
// emitFile / writeFile + relativeUrl rewrite (D-1 rejects yielding a full
// imported row from the shared fn).
//
// Package home (plan-strategy D-6 / section 5.6): this fn lives in the
// build-time `@forgeax/engine-vite-plugin-pack` package, NOT in
// `packages/runtime/src/` -- it orchestrates `imageImporter` (an
// `@forgeax/engine-image` symbol) and `check-image-pipeline-isolation.mjs`
// forbids runtime/src from statically importing `@forgeax/engine-image`.
//
// .hdr arm (R-6 / AC-12): the `.hdr` extension dispatches to the
// imageImporter HDR arm (decode -> f16 -> rgba16float). This logic is
// preserved byte-for-byte from the prior in-line import block.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import type {
  ImageMetadata,
  ImportContext,
  PackIndexEntry,
  TextureAsset,
} from '@forgeax/engine-types';

/** Options for {@link importTextureEntry}. */
export interface ImportTextureOptions {
  /** Base directory the entry's relative `sourcePath` resolves against. */
  readonly cwd: string;
}

/**
 * Outcome of importing a single texture pack-index row.
 *
 * `bytes` are the imported, tight-packed texel bytes (rgba8 for image arm,
 * rgba16float for the .hdr arm). `metadata` folds the
 * width / height / format / colorSpace / mipmap fields the caller writes
 * into the catalog row. The shared fn never returns a `relativeUrl`
 * (D-1): the build arm rewrites it from `emitFile` + `getFileName`, and
 * the dev arm from the written `.bin` path -- each call site owns that.
 *
 * The `skipped` variant carries `real`: this is the one SSOT distinguishing a
 * BENIGN skip (`real: false` -- the row is simply not an importable image:
 * non-texture kind, missing metadata, unknown extension) that callers pass
 * through unchanged, from a REAL failure (`real: true` -- the source could not
 * be read / decoded, or the importer produced nothing) that callers must
 * surface as a structured error rather than swallow. Previously each caller
 * re-derived this from a `skipped.startsWith('failed to import')` prefix match.
 */
export type ImportTextureResult =
  | { readonly bytes: Uint8Array; readonly metadata: ImageMetadata }
  | { readonly skipped: string; readonly real: boolean };

/**
 * Import one `kind: 'texture'` pack-index row into `{ bytes, metadata }`.
 *
 * Builds a one-subAsset `ImportContext` for the entry's source, dispatches
 * to the build-time `imageImporter` (the same Importer the
 * `@forgeax/engine-import` runner routes `meta.importer === 'image'` to),
 * extracts the imported `TextureAsset.data` bytes, and folds the catalog
 * metadata. Rows that are not importable images (non-texture kind, missing
 * metadata, an unknown extension that is neither a standard image mime nor
 * `.hdr`, an importer throw, or an absent produced asset) return
 * `{ skipped }` so the caller can pass the original row through unchanged.
 *
 * @internal -- shared between the build `generateBundle` import arm and the
 *   dev `POST /__import` path; not part of the public plugin surface.
 */
export async function importTextureEntry(
  entry: PackIndexEntry,
  opts: ImportTextureOptions,
): Promise<ImportTextureResult> {
  if (
    entry.kind !== 'texture' ||
    entry.metadata === undefined ||
    entry.metadata.kind !== 'texture'
  ) {
    return { skipped: 'non-texture or missing texture metadata', real: false };
  }
  const meta = entry.metadata;
  const sourceAbs = resolve(opts.cwd, entry.sourcePath);

  // mime discrimination: standard image extensions import directly; .hdr
  // dispatches to the imageImporter HDR arm (R-6, byte-for-byte preserved);
  // any other unknown extension is skipped so the catalog is not silently
  // dropped (the caller passes the raw row through).
  const lower = sourceAbs.toLowerCase();
  const isImageMime = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
  if (!isImageMime && !lower.endsWith('.hdr')) {
    return {
      skipped: `unknown extension (no image mime / not .hdr): ${entry.sourcePath}`,
      real: false,
    };
  }

  // Build the one-subAsset ImportContext (GUID import-stable iron law: the
  // produced GUID is the entry's GUID). `readSource` reads the source bytes
  // lazily; `importSettings` carries the colorSpace / mipmap the catalog
  // already derived so the importer folds the same texture format.
  const ctx: ImportContext = {
    source: sourceAbs,
    readSource: async () => {
      try {
        const buf = await readFile(sourceAbs);
        return { ok: true, value: new Uint8Array(buf) };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    // image-source-bare cook does not chase sibling refs nor invoke the
    // decodeImage seam (gltfImporter is the only consumer of those today);
    // wire fail-fast stubs so the gap is loud if a future importer reaches
    // for them on this codepath.
    readSibling: async () => ({ ok: true, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error(
        'decodeImage seam unwired in vite-plugin-pack import-texture (bare-source path); reach the gltfImporter codepath through buildCatalog instead',
      );
    },
    subAssets: [{ guid: entry.guid, sourceIndex: 0, kind: 'image' }],
    importSettings: { colorSpace: meta.colorSpace, mipmap: meta.mipmap },
  };
  let produced: readonly { guid: string; payload: unknown }[];
  try {
    produced = await imageImporter.import(ctx);
  } catch (e) {
    return {
      skipped: `failed to import texture ${entry.sourcePath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      real: true,
    };
  }
  const imported = produced.find((a) => a.guid === entry.guid)?.payload as TextureAsset | undefined;
  if (imported === undefined) {
    return {
      skipped: `imageImporter produced no asset for ${entry.sourcePath} (guid ${entry.guid})`,
      real: true,
    };
  }
  // The imported texel bytes ride in TextureAsset.data (Uint8Array |
  // Uint8ClampedArray); normalise to a Uint8Array view.
  const bytes =
    imported.data instanceof Uint8Array
      ? imported.data
      : new Uint8Array(imported.data.buffer, imported.data.byteOffset, imported.data.byteLength);
  return {
    bytes,
    metadata: {
      kind: 'texture',
      width: imported.width,
      height: imported.height,
      format: meta.format,
      colorSpace: meta.colorSpace,
      mipmap: meta.mipmap,
    },
  };
}
