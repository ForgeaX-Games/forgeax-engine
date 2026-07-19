/**
 * @forgeax/engine-codec
 *
 * Runtime-safe zstd decode + KTX2 container parse for the forgeax asset pipeline.
 * Build-time zstd encode lives in the `./encode` subpath.
 */

export type {
  TranscodedMip,
  TranscodedTexture,
} from './basis-transcoder.js';
export {
  _basisTranscoderInitCount,
  _setBasisTranscoderImporter,
  initBasisTranscoder,
  transcodeKtx2,
} from './basis-transcoder.js';
export type { BlockParams } from './block-format.js';
export {
  blockParamsForFormat,
  bytesPerRow,
  isCompressedFormat,
  rowsPerImage,
} from './block-format.js';
export type { CodecError, CodecErrorCode, CodecOk, CodecResult } from './errors.js';
export { codecError } from './errors.js';
export { KTX2_IDENTIFIER, ktx2LevelsToRGBA, parseKtx2 } from './ktx2.js';
export type {
  TranscodeCaps,
  TranscodeChannels,
  TranscodeModel,
  TranscodeSource,
} from './transcode.js';
export { selectTranscodeTarget } from './transcode.js';
export { _setZstdImporter, _zstdInitCount, decompressZstd } from './zstd.js';
