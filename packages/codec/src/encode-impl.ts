import { createRequire } from 'node:module';
import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';

/**
 * CJS require for @bokuweb/zstd-wasm (build-time Node.js only).
 *
 * @bokuweb/zstd-wasm is distributed as a CommonJS package with a `.wasm`
 * sidecar. We use createRequire to load it from ESM, since it does not
 * provide ESM exports.
 */
const zstdRequire = createRequire(import.meta.url);

interface ZstdWasm {
  init(): Promise<void>;
  compress(buf: Uint8Array, level?: number): Uint8Array;
}

/** Lazy-init singleton handle for the build-time zstd WASM encoder. @internal */
let _zstd: ZstdWasm | null = null;

async function getZstd(): Promise<ZstdWasm> {
  if (_zstd !== null) {
    return _zstd;
  }
  const mod: ZstdWasm = zstdRequire('@bokuweb/zstd-wasm');
  await mod.init();
  _zstd = mod;
  return _zstd;
}

/**
 * Compress bytes with zstd using a fixed compression level (level 3 = default).
 *
 * Build-time only. Uses @bokuweb/zstd-wasm pinned at 0.0.27 for
 * deterministic output (same input + same level = byte-identical output).
 *
 * Returns `{ ok: true, value: compressed }` on success.
 * Returns `{ ok: false, error: { code: 'decompression-failed', ... } }` on failure
 * (encoding failures mapped to decompression-failed per D-8, same code different detail).
 */
export async function compressZstd(bytes: Uint8Array): Promise<CodecResult<Uint8Array>> {
  try {
    const zstd = await getZstd();
    const result = zstd.compress(bytes, 3);
    return { ok: true, value: result };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return codecError('decompression-failed', {
      reason: `zstd compression failed: ${reason}`,
    });
  }
}
