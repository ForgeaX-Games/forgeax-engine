// @forgeax/engine-assets-runtime -- upstream-branch (texture / font / equirect)
// loader bodies (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1
// straight-cut). Pure move from asset-registry.ts; zero identifier changes.

import type { TranscodeModel } from '@forgeax/engine-codec';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AssetCompression,
  EquirectAsset,
  FontAsset,
  ImageMetadata,
  LoadContext,
  Loader,
  LoaderAsyncResult,
  TextureAsset,
  TranscodeCaps,
} from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError } from '@forgeax/engine-types';
import { makeImageError } from '../image-error';
import { numMipLevels } from '../mipmap-generator';

// === Upstream-branch loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w6) ===
//
// texture / font are the two kinds that, pre-refactor, were dispatched on
// `entry.kind` in `loadByGuidProd` (above `parseAssetPayload`) through bespoke
// `loadTextureFromEntry` / `loadFontFromEntry` methods (research Finding 2).
// w6 extracts those bodies here as async loaders. They receive the catalog
// `entry` (relativeUrl + optional metadata) as the `payload` argument and use
// the injected `LoadContext` (`fetchBinary` / `resolveRef`) instead of reaching
// into `AssetRegistry` internals. They produce the `Asset` POD only;
// `registerWithGuid` stays in `loadByGuidProd` (D-2).
//
// M3 (feat-20260603-asset-import-loader-injection / w26, AC-15): the image
// decoder left the runtime. The static `@forgeax/engine-image` imports
// (`decodeImageInBrowser` / `decodeHdr`) and the dynamic node `parseImage`
// branch are gone -- the texture loader now reads ONLY a build-time-imported
// RGBA `.bin` produced by the `imageImporter` (engine-image), and a raw image
// source (`.jpg` / `.png` / `.hdr`) reaching the runtime loader is a misconfig
// that fails fast (charter P3) rather than triggering a runtime decode. The
// decode lives behind the build-time import pipeline (the runtime is the GPU
// consumer; the disk decoder is build-time only).

/** Catalog entry shape the texture / font loaders read from the `payload` slot. */
interface LoaderEntry {
  readonly guidKey: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly metadata?: ImageMetadata | undefined;
  /** Build-time compression strategy for this artefact. `undefined` = legacy uncompressed. */
  readonly compression?: AssetCompression;
}

/** texture loader — fetch bytes -> hdr / import / dev decode -> TextureAsset POD. */
export const textureLoader: Loader = {
  kind: 'texture',
  fromCatalogEntry: true,
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadTextureAsset(entry, ctx);
  },
};

async function loadTextureAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  // feat-20260604-hdr-equirect-cube-importer-loader M2 / D-1 (import-state signal
  // converged 2026-06-06): the runtime reads only a build-time-imported RGBA
  // `.bin`. The `.bin` suffix is the SINGLE import-state judgement and it is
  // checked FIRST -- before the metadata check -- so an unimported texture row
  // always surfaces the dedicated `texture-source-not-imported` sentinel
  // (transport-eligible) regardless of whether its `metadata` is fully folded.
  // (Previously the metadata check ran first; a raw row missing width/height
  // returned the non-transport-eligible `image-meta-missing` ImageError and the
  // import-on-demand route was never reached.) `image-decode-failed` stays
  // reserved for a genuinely corrupt imported `.bin` and is never
  // transport-eligible, so a real decode failure is never silently lazy-imported.
  // `.ktx2` is also an import-state suffix (KTX2 container dispatched by magic
  // byte check downstream, D-5).
  if (!entry.relativeUrl.endsWith('.bin') && !entry.relativeUrl.endsWith('.ktx2')) {
    return {
      ok: false,
      error: new AssetError({
        code: 'texture-source-not-imported',
        expected: `a build-time-imported RGBA .bin or KTX2 .ktx2 for texture ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }

  const meta = entry.metadata;
  if (meta === undefined || meta.kind !== 'texture') {
    return {
      ok: false,
      error: makeImageError({
        code: 'image-meta-missing',
        sourcePath: entry.relativeUrl,
        expectedSidecarPath: `${entry.relativeUrl}.meta.json`,
      }),
    };
  }

  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const bytes = fetched.value;

  // feat-20260707 M5 / w34 (AC-04, AC-11b): Basis transcode arm. A catalog row
  // whose `compression` is a `basis-*` member is a Basis KTX2 payload: parse the
  // container, pick a transcode target from `ctx.transcodeCaps` (the codec's
  // pure `selectTranscodeTarget`), transcode every mip level, and stamp
  // `TextureAsset.format` with the chosen target -- no `rgba8unorm` hardcode.
  // fetchBinary already passed basis-* through un-zstd'd (the single zstd gate
  // only fires on 'zstd'), so the transcode sits after the ONE decompression
  // point (AC-11b -- no second decode call site). scheme=0/2 KTX2 (compression
  // absent or 'zstd') skips this arm and takes the RGBA path below unchanged.
  if (
    entry.compression === 'basis-etc1s' ||
    entry.compression === 'basis-uastc' ||
    entry.compression === 'basis-uastc-hdr'
  ) {
    return transcodeBasisTexture(entry, bytes, meta.colorSpace, ctx.transcodeCaps);
  }

  // KTX2 magic dispatch (D-5): cheap first-byte sniff (0xAB) keeps non-KTX2
  // texture loads from importing the codec, then verify the full 12-byte
  // identifier against the codec's SSOT constant so runtime and codec cannot
  // drift on the magic bytes.
  if (bytes.length >= 12 && bytes[0] === 0xab) {
    const { KTX2_IDENTIFIER, ktx2LevelsToRGBA, parseKtx2 } = await import('@forgeax/engine-codec');
    if (KTX2_IDENTIFIER.every((m, i) => bytes[i] === m)) {
      try {
        const parsed = await parseKtx2(bytes);
        if (!parsed.ok) {
          return {
            ok: false,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: 'valid KTX2 texture container',
              hint: `KTX2 parse failed (${parsed.error.code}): ${(parsed.error.detail as { reason: string }).reason}. ${parsed.error.hint}`,
              detail: { sourcePath: entry.relativeUrl },
            }),
          };
        }

        const rgba = await ktx2LevelsToRGBA(parsed.value, 0);
        if (!rgba.ok) {
          return {
            ok: false,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: 'decompressable KTX2 level data',
              hint: `KTX2 level decode failed (${rgba.error.code}): ${JSON.stringify(rgba.error.detail)}. ${rgba.error.hint}`,
              detail: { sourcePath: entry.relativeUrl },
            }),
          };
        }

        const texAsset: TextureAsset = {
          kind: 'texture',
          width: parsed.value.header.pixelWidth,
          height: parsed.value.header.pixelHeight,
          format: 'rgba8unorm',
          data: rgba.value,
          colorSpace: meta.colorSpace,
          mipmap: meta.mipmap,
          mipLevelCount: Math.max(1, parsed.value.header.levelCount),
        };
        return { ok: true, value: texAsset };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: new AssetError({
            code: 'asset-fetch-failed',
            expected: 'loadable KTX2 texture',
            hint: `KTX2 codec dynamic import or parse failed: ${message}. Check that @forgeax/engine-codec is installed.`,
            detail: { sourcePath: entry.relativeUrl },
          }),
        };
      }
    }
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const levels = meta.mipmap === true ? numMipLevels({ width, height }) : 1;
  const texAsset: TextureAsset = {
    kind: 'texture',
    width,
    height,
    format: meta.format,
    data: bytes,
    colorSpace: meta.colorSpace,
    mipmap: meta.mipmap,
    mipLevelCount: levels,
  };
  return { ok: true, value: texAsset };
}

/**
 * Map a `basis-*` catalog compression member to the codec's `TranscodeModel`
 * (feat-20260707 M5 / w34). The build-time delivery encoding is the authoritative
 * source-model signal (it is what the encoder wrote), so the loader reads it
 * straight off the catalog row rather than re-deriving the model from the DFD.
 */
function transcodeModelFor(
  compression: 'basis-etc1s' | 'basis-uastc' | 'basis-uastc-hdr',
): TranscodeModel {
  switch (compression) {
    case 'basis-etc1s':
      return 'etc1s';
    case 'basis-uastc':
      return 'uastc-ldr';
    case 'basis-uastc-hdr':
      return 'uastc-hdr';
  }
}

/**
 * Concatenate the mip-major transcoded level byte arrays into one buffer the GPU
 * upload path slices per level via `deriveMipUploadLayout` (feat-20260707 M5 /
 * w34). Level order is base-first, matching the layout the store walks.
 */
function concatTranscodedMips(mips: readonly { readonly data: Uint8Array }[]): Uint8Array {
  let total = 0;
  for (const m of mips) total += m.data.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const m of mips) {
    out.set(m.data, offset);
    offset += m.data.length;
  }
  return out;
}

/**
 * Transcode a Basis KTX2 payload into a `TextureAsset` (feat-20260707 M5 / w34,
 * AC-04). Parses the container, picks a `GPUTextureFormat` target from the
 * device caps via the codec's pure `selectTranscodeTarget` (no cap -> an
 * uncompressed `rgba8unorm[-srgb]` fallback, section 8 P3), transcodes every mip
 * level, and stamps `TextureAsset.format` with the chosen target. `mipmap` /
 * `mipLevelCount` mirror the transcoded chain truthfully, so a multi-level
 * compressed chain (offline mips) never trips the runtime-mip-gen gate (w35).
 */
async function transcodeBasisTexture(
  entry: LoaderEntry,
  bytes: Uint8Array,
  colorSpace: 'srgb' | 'linear',
  caps: TranscodeCaps,
): Promise<LoaderAsyncResult> {
  const compression = entry.compression as 'basis-etc1s' | 'basis-uastc' | 'basis-uastc-hdr';
  try {
    const { parseKtx2, selectTranscodeTarget, transcodeKtx2 } = await import(
      '@forgeax/engine-codec'
    );
    const parsed = await parseKtx2(bytes);
    if (!parsed.ok) {
      return {
        ok: false,
        error: new AssetError({
          code: 'asset-fetch-failed',
          expected: 'valid Basis KTX2 texture container',
          hint: `KTX2 parse failed (${parsed.error.code}): ${JSON.stringify(parsed.error.detail)}. ${parsed.error.hint}`,
          detail: { sourcePath: entry.relativeUrl },
        }),
      };
    }

    // The encoder produces RGBA color / HDR RGBA payloads (the image arm feeds
    // 4-channel sources); RG / R data-channel encode is not on the M3 encoder
    // path, so the loader selects on the 'rgba' arm. srgb follows the catalog
    // colorSpace (only the LDR color arm varies on it).
    const targetFormat = selectTranscodeTarget(
      { model: transcodeModelFor(compression), srgb: colorSpace === 'srgb', channels: 'rgba' },
      caps,
    );

    const transcoded = await transcodeKtx2(parsed.value, targetFormat);
    if (!transcoded.ok) {
      return {
        ok: false,
        error: new AssetError({
          code: 'asset-fetch-failed',
          expected: `transcodable Basis KTX2 (${compression}) to ${targetFormat}`,
          hint: `Basis transcode failed (${transcoded.error.code}): ${JSON.stringify(transcoded.error.detail)}. ${transcoded.error.hint}`,
          detail: { sourcePath: entry.relativeUrl },
        }),
      };
    }

    const mips = transcoded.value.mips;
    const texAsset: TextureAsset = {
      kind: 'texture',
      width: transcoded.value.width,
      height: transcoded.value.height,
      format: targetFormat,
      data: concatTranscodedMips(mips),
      colorSpace,
      // Truthful mip projection: a multi-level offline chain sets mipmap:true +
      // mipLevelCount=N, which the w35 gate treats as an offline chain (no
      // runtime mip-gen requested). A single level stays mipmap:false.
      mipmap: mips.length > 1,
      mipLevelCount: Math.max(1, mips.length),
    };
    return { ok: true, value: texAsset };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-fetch-failed',
        expected: 'loadable Basis KTX2 texture',
        hint: `Basis codec dynamic import or transcode failed: ${message}. Check that @forgeax/engine-codec is installed.`,
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }
}

/**
 * equirect loader (feat-20260630 M1 / w4) -- fetch the build-time-imported
 * rgba16float `.bin` and assemble an EquirectAsset POD. An equirect `.hdr`
 * folds to a single 2D image with a disk identity (unlike the retired
 * cube-texture), so it rides the same upstream-entry `.bin` path as
 * textureLoader. D-2: independent async body, no shared `.bin` parser helper
 * (the inline assembly is the whole body; abstraction would add a concept).
 */
export const equirectLoader: Loader = {
  kind: 'equirect',
  fromCatalogEntry: true,
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadEquirectAsset(entry, ctx);
  },
};

async function loadEquirectAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  // The `.bin` (uncompressed rgba16float) suffix is the single import-state
  // judgement (mirrors loadTextureAsset): an unimported equirect row fails fast
  // with the dedicated sentinel rather than reaching fetchBinary on a raw `.hdr`.
  //
  // feat-20260707 M5 fix: equirect is ALWAYS delivered uncompressed rgba16float.
  // An equirect drives equirect-to-cube / irradiance / prefilter RENDER passes,
  // and a BC6H (block-compressed) source is sample-only, never color-renderable,
  // so it is never block-compressed (import-texture.ts forces compression 'none').
  // There is therefore no Basis UASTC-HDR `.ktx2` equirect arm -- the `.bin` path
  // below is the whole body.
  if (!entry.relativeUrl.endsWith('.bin')) {
    return {
      ok: false,
      error: new AssetError({
        code: 'texture-source-not-imported',
        expected: `a build-time-imported rgba16float .bin for equirect ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  }

  const meta = entry.metadata;
  if (meta === undefined || meta.kind !== 'texture') {
    return {
      ok: false,
      error: makeImageError({
        code: 'image-meta-missing',
        sourcePath: entry.relativeUrl,
        expectedSidecarPath: `${entry.relativeUrl}.meta.json`,
      }),
    };
  }

  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const equirectAsset: EquirectAsset = {
    kind: 'equirect',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format,
    data: fetched.value,
    colorSpace: meta.colorSpace,
  };
  return { ok: true, value: equirectAsset };
}

/** font loader — fetch pack JSON -> resolve atlas/sampler refs -> FontAsset POD. */
export const fontLoader: Loader = {
  kind: 'font',
  fromCatalogEntry: true,
  load(payload, _refs, ctx): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as LoaderEntry;
    return loadFontAsset(entry, ctx);
  },
};

async function loadFontAsset(entry: LoaderEntry, ctx: LoadContext): Promise<LoaderAsyncResult> {
  const fetched = await ctx.fetchBinary(
    entry.relativeUrl,
    entry.compression ? { compression: entry.compression } : undefined,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fetched.value)) as unknown;
  } catch {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-fetch-failed',
        expected: `font pack file ${entry.relativeUrl} to parse as JSON`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    };
  }

  const packFile = raw as {
    assets?: Array<{ guid: string; kind: string; payload: Record<string, unknown> }>;
  };
  const fontEntry = (packFile.assets ?? []).find(
    (a) => a.guid.toLowerCase() === entry.guidKey.toLowerCase(),
  );
  if (fontEntry === undefined) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${entry.guidKey} present in pack file ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    };
  }
  const payloadObj = fontEntry.payload;

  const atlasGuidStr = payloadObj.atlasGuid;
  const samplerGuidStr = payloadObj.samplerGuid;
  if (typeof atlasGuidStr !== 'string' || typeof samplerGuidStr !== 'string') {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'font pack payload to contain atlasGuid and samplerGuid string fields',
        hint: 'atlas texture and sampler GUIDs must be present in the font pack payload',
      }),
    };
  }

  // feat-20260614 M8 (D-19): ensure the atlas + sampler sub-assets are
  // catalogued (recursive load), then store their GUIDs (AssetGuid) on the
  // FontAsset -- the registry never mints; the glyph layout / render side
  // resolves GUID -> column handle at use time.
  const atlasGuidParsed = AssetGuid.parse(atlasGuidStr);
  if (!atlasGuidParsed.ok) return { ok: false, error: atlasGuidParsed.error };
  const samplerGuidParsed = AssetGuid.parse(samplerGuidStr);
  if (!samplerGuidParsed.ok) return { ok: false, error: samplerGuidParsed.error };
  const atlasResolved = await ctx.resolveRef(atlasGuidStr);
  if (!atlasResolved.ok) return { ok: false, error: atlasResolved.error };
  const samplerResolved = await ctx.resolveRef(samplerGuidStr);
  if (!samplerResolved.ok) return { ok: false, error: samplerResolved.error };

  const glyphsParsed = parseFontGlyphs(payloadObj.glyphs);
  if (!glyphsParsed.ok) return { ok: false, error: glyphsParsed.error };
  const commonParsed = parseFontCommon(payloadObj.common);
  if (!commonParsed.ok) return { ok: false, error: commonParsed.error };
  const notdef = parseFontNotdef(payloadObj.notdef);

  const fontAsset: FontAsset = {
    kind: 'font',
    atlas: atlasGuidParsed.value,
    sampler: samplerGuidParsed.value,
    glyphs: glyphsParsed.value,
    common: commonParsed.value,
    ...(notdef !== undefined ? { notdef } : {}),
  };
  return { ok: true, value: fontAsset };
}

/** Parse the font payload `glyphs` Record into typed GlyphMetric entries. */
function parseFontGlyphs(
  glyphsRaw: unknown,
): { ok: true; value: FontAsset['glyphs'] } | { ok: false; error: AssetError } {
  if (typeof glyphsRaw !== 'object' || glyphsRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'glyphs field to be a Record<number, GlyphMetric>',
        hint: `got ${typeof glyphsRaw}`,
      }),
    };
  }
  const glyphs: FontAsset['glyphs'] = {};
  for (const [codepointStr, g] of Object.entries(glyphsRaw as Record<string, unknown>)) {
    const codepoint = Number(codepointStr);
    if (Number.isNaN(codepoint)) continue;
    if (typeof g !== 'object' || g === null) continue;
    const m = g as Record<string, unknown>;
    const size = m.size as Record<string, unknown> | undefined;
    const region = m.region as Record<string, unknown> | undefined;
    if (
      typeof m.advance !== 'number' ||
      typeof m.bearingX !== 'number' ||
      typeof m.bearingY !== 'number' ||
      typeof size !== 'object' ||
      size === null ||
      typeof size.w !== 'number' ||
      typeof size.h !== 'number' ||
      typeof region !== 'object' ||
      region === null ||
      typeof region.x !== 'number' ||
      typeof region.y !== 'number' ||
      typeof region.w !== 'number' ||
      typeof region.h !== 'number'
    ) {
      continue;
    }
    glyphs[codepoint] = {
      advance: m.advance,
      bearingX: m.bearingX,
      bearingY: m.bearingY,
      size: { w: size.w, h: size.h },
      region: { x: region.x, y: region.y, w: region.w, h: region.h },
    };
  }
  return { ok: true, value: glyphs };
}

/** Parse the font payload `common` block. */
function parseFontCommon(
  commonRaw: unknown,
): { ok: true; value: FontAsset['common'] } | { ok: false; error: AssetError } {
  if (typeof commonRaw !== 'object' || commonRaw === null) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common field to be present',
        hint: `got ${typeof commonRaw}`,
      }),
    };
  }
  const cm = commonRaw as Record<string, unknown>;
  if (
    typeof cm.lineHeight !== 'number' ||
    typeof cm.base !== 'number' ||
    typeof cm.distanceRange !== 'number' ||
    typeof cm.pxRange !== 'number' ||
    typeof cm.atlasWidth !== 'number' ||
    typeof cm.atlasHeight !== 'number'
  ) {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'common block to contain all required number fields',
        hint: 'common block must have lineHeight, base, distanceRange, pxRange, atlasWidth, atlasHeight',
      }),
    };
  }
  return {
    ok: true,
    value: {
      lineHeight: cm.lineHeight,
      base: cm.base,
      distanceRange: cm.distanceRange,
      pxRange: cm.pxRange,
      atlasWidth: cm.atlasWidth,
      atlasHeight: cm.atlasHeight,
    },
  };
}

/** Parse the optional font payload `notdef` glyph. */
function parseFontNotdef(notdefRaw: unknown): FontAsset['notdef'] | undefined {
  if (typeof notdefRaw !== 'object' || notdefRaw === null) return undefined;
  const nd = notdefRaw as Record<string, unknown>;
  if (
    typeof nd.advance !== 'number' ||
    typeof nd.bearingX !== 'number' ||
    typeof nd.bearingY !== 'number'
  ) {
    return undefined;
  }
  const size = nd.size as Record<string, unknown> | undefined;
  const region = nd.region as Record<string, unknown> | undefined;
  return {
    advance: nd.advance,
    bearingX: nd.bearingX,
    bearingY: nd.bearingY,
    size: {
      w: typeof size?.w === 'number' ? size.w : 0,
      h: typeof size?.h === 'number' ? size.h : 0,
    },
    region: {
      x: typeof region?.x === 'number' ? region.x : 0,
      y: typeof region?.y === 'number' ? region.y : 0,
      w: typeof region?.w === 'number' ? region.w : 0,
      h: typeof region?.h === 'number' ? region.h : 0,
    },
  };
}

/**
 * The two upstream-branch loaders that consume a catalog entry directly
 * (research Finding 2): they are dispatched from `loadByGuidProd` off the entry
 * (not via the `.pack.json` -> parseAssetPayload path). `UPSTREAM_ENTRY_KINDS`
 * lets `loadByGuidProd` route to them without a hardcoded `if (entry.kind ===
 * ...)` chain (AC-01); it is derived from the loader objects so the kind
 * strings have one source.
 */
export const UPSTREAM_ENTRY_LOADERS: readonly Loader[] = [
  textureLoader,
  fontLoader,
  equirectLoader,
];
export const UPSTREAM_ENTRY_KINDS: ReadonlySet<string> = new Set(
  UPSTREAM_ENTRY_LOADERS.map((l) => l.kind),
);

// perf-20260706: raw source-container extensions. A pack-index row whose
// relativeUrl still ends in one of these has NOT been import-cooked yet -- the
// vite-plugin-pack gltf/fbx catalog arm emits thin mesh/material/scene rows
// pointing at the source container, and only the ImportTransport (dev
// `POST /__import/:guid`) rewrites each to an importer artifact (`.<guid>.bin`).
// ddcLoad fails such rows fast (asset-not-imported) so they route to the
// transport instead of fetch+parse-failing the whole (possibly 62 MB) binary
// container once per sub-asset. Extension check only -- the importer's output
// suffix is always `.bin` / `.pack.json`, never these.
const RAW_ASSET_CONTAINER_EXTS: readonly string[] = ['.glb', '.gltf', '.fbx'];

export function isRawAssetContainerUrl(relativeUrl: string): boolean {
  const q = relativeUrl.indexOf('?');
  const path = (q === -1 ? relativeUrl : relativeUrl.slice(0, q)).toLowerCase();
  return RAW_ASSET_CONTAINER_EXTS.some((ext) => path.endsWith(ext));
}
