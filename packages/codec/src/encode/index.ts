/**
 * @forgeax/engine-codec/encode
 *
 * Build-time zstd encoding subpath.
 * Gated from runtime import by `check-image-pipeline-isolation.mjs` path d.
 */
export { compressZstd } from '../encode-impl.js';
