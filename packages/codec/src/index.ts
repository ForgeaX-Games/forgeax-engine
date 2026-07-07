/**
 * @forgeax/engine-codec
 *
 * Runtime-safe zstd decode + KTX2 container parse for the forgeax asset pipeline.
 * Build-time zstd encode lives in the `./encode` subpath.
 */

export type { CodecError, CodecErrorCode, CodecOk, CodecResult } from './errors.js';
export { codecError } from './errors.js';
export { KTX2_IDENTIFIER, ktx2LevelsToRGBA, parseKtx2 } from './ktx2.js';
export { _setZstdImporter, _zstdInitCount, decompressZstd } from './zstd.js';
