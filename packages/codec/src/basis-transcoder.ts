/**
 * Basis transcoder glue: lazy-init singleton (D-10) + per-mip KTX2 transcode.
 *
 * `initBasisTranscoder` dynamic-imports the self-built transcoder WASM module on
 * first call and caches it; the second call returns the same instance without
 * re-importing (D-10 main-thread lazy-init -- `Engine.create` does not preload,
 * the first Basis payload triggers this). No worker pool (OOS -- forgeax has no
 * worker infrastructure). Both node and browser can `import` this module: the
 * WASM glue is a MODULARIZE factory whose `.mjs` path resolves in both.
 *
 * `transcodeKtx2` opens a parsed KTX2 container's raw bytes as a basis KTX2File,
 * starts transcoding, and transcodes every mip level (mip-major) into the target
 * `GPUTextureFormat`. It returns the block (or pixel) byte arrays per level; it
 * does not upload -- the runtime upload path (M5) consumes these with the block
 * table.
 */

import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';
import type { Ktx2Parsed } from './ktx2.js';
import type { BasisModuleFactory, BasisTranscoderModule } from './wasm/basis-types.js';

/** How the transcoder WASM module is loaded. Overridable in tests. */
type TranscoderImporter = () => Promise<BasisTranscoderModule>;

const TRANSCODER_GLUE = new URL('../pkg/basis_transcoder.mjs', import.meta.url);
const TRANSCODER_WASM = new URL('../pkg/basis_transcoder.wasm', import.meta.url);

const defaultImporter: TranscoderImporter = async () => {
  const factory = (
    (await import(/* @vite-ignore */ TRANSCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisTranscoderModule>;
    }
  ).default;
  const mod = await factory({ locateFile: () => TRANSCODER_WASM.href });
  mod.initializeBasis();
  return mod;
};

let importer: TranscoderImporter = defaultImporter;

/**
 * Lazy-init singleton (D-10): null = never attempted, Promise = init in flight,
 * resolved = ready, rejected = cleared so the next call retries.
 * @internal
 */
let _initPromise: Promise<BasisTranscoderModule> | null = null;

/** Count of importer invocations; observed in tests to prove single-init. @internal */
let initCount = 0;

/**
 * Lazy-init the Basis transcoder WASM module (D-10 main-thread singleton).
 * First call dynamic-imports + initializes; subsequent calls return the cache.
 */
export function initBasisTranscoder(): Promise<BasisTranscoderModule> {
  if (_initPromise !== null) return _initPromise;
  initCount++;
  _initPromise = importer().catch((cause: unknown) => {
    _initPromise = null;
    throw new Error('codec-init-failed', { cause });
  });
  return _initPromise;
}

/**
 * Test-only: number of times the transcoder importer has been invoked. Proves
 * the lazy singleton loads the module at most once (D-10).
 * @internal
 */
export function _basisTranscoderInitCount(): number {
  return initCount;
}

/**
 * Test-only: reset the lazy singleton and optionally override the importer.
 * Call with no argument to restore the real WASM importer.
 * @internal
 */
export function _setBasisTranscoderImporter(next?: TranscoderImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
  initCount = 0;
}

/** One transcoded mip level (mip-major output). */
export interface TranscodedMip {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  /** Transcoded block (compressed) or pixel (uncompressed) bytes for this level. */
  readonly data: Uint8Array;
}

/** Result of transcoding a KTX2 container into a target GPU format. */
export interface TranscodedTexture {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** Mip levels, base (level 0 / largest) first. */
  readonly mips: readonly TranscodedMip[];
}

/**
 * Map a selected `GPUTextureFormat` to a basis `transcoder_texture_format` enum
 * value. sRGB variants share the transcode target (sRGB is a view/DFD concern,
 * not a distinct transcode format). Uncompressed single/dual-channel fallbacks
 * (r8/rg8) route through RGBA32 -- basis has no r8/rg8 uncompressed target; the
 * runtime upload path (M5) reconciles channel selection.
 */
function basisTargetFor(mod: BasisTranscoderModule, format: GPUTextureFormat): number | null {
  const e = mod.transcoder_texture_format;
  switch (format) {
    case 'bc7-rgba-unorm':
    case 'bc7-rgba-unorm-srgb':
      return e.cTFBC7_RGBA.value;
    case 'bc5-rg-unorm':
      return e.cTFBC5_RG.value;
    case 'bc4-r-unorm':
      return e.cTFBC4_R.value;
    case 'bc6h-rgb-ufloat':
      return e.cTFBC6H.value;
    case 'etc2-rgba8unorm':
    case 'etc2-rgba8unorm-srgb':
      return e.cTFETC2_RGBA.value;
    case 'astc-4x4-unorm':
    case 'astc-4x4-unorm-srgb':
      return e.cTFASTC_4x4_RGBA.value;
    case 'rgba16float':
      return e.cTFRGBA_HALF.value;
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
    case 'rg8unorm':
    case 'r8unorm':
      return e.cTFRGBA32.value;
    default:
      return null;
  }
}

/**
 * Transcode every mip level of a parsed KTX2 container into `targetFormat`.
 *
 * Uses `parsed.rawBytes` as the basis KTX2File source. Returns one entry per mip
 * level (base first). On any basis-side failure returns a `transcode-failed`
 * CodecError carrying the source DFD color model and the target format.
 */
export async function transcodeKtx2(
  parsed: Ktx2Parsed,
  targetFormat: GPUTextureFormat,
): Promise<CodecResult<TranscodedTexture>> {
  let mod: BasisTranscoderModule;
  try {
    mod = await initBasisTranscoder();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-basis-transcoder' });
  }

  const targetEnum = basisTargetFor(mod, targetFormat);
  if (targetEnum === null) {
    return codecError('transcode-failed', {
      sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}`,
      targetFormat,
    });
  }

  const file = new mod.KTX2File(parsed.rawBytes);
  try {
    if (!file.isValid()) {
      return codecError('transcode-failed', {
        sourceFormat: 'invalid-ktx2-file',
        targetFormat,
      });
    }
    if (file.startTranscoding() === 0) {
      return codecError('transcode-failed', {
        sourceFormat: 'start-transcoding-failed',
        targetFormat,
      });
    }

    const levels = file.getLevels();
    const mips: TranscodedMip[] = [];
    for (let level = 0; level < levels; level++) {
      const info = file.getImageLevelInfo(level, 0, 0);
      const size = file.getImageTranscodedSizeInBytes(level, 0, 0, targetEnum);
      const dst = new Uint8Array(size);
      const ok = file.transcodeImage(dst, level, 0, 0, targetEnum, 0, -1, -1);
      if (ok === 0) {
        return codecError('transcode-failed', {
          sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}-level-${level}`,
          targetFormat,
        });
      }
      mips.push({ level, width: info.origWidth, height: info.origHeight, data: dst });
    }

    return {
      ok: true,
      value: {
        format: targetFormat,
        width: file.getWidth(),
        height: file.getHeight(),
        mips,
      },
    };
  } finally {
    file.close();
  }
}
