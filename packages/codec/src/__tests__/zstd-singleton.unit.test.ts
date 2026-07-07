import { _setZstdImporter, _zstdInitCount, decompressZstd } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * zstd lazy-init singleton test (w5).
 *
 * Validates that the decompressZstd implementation:
 * 1. Does NOT trigger the fzstd importer until the first decompress call (AC-12 zero-cost).
 * 2. Loads the decompressor exactly once even under concurrent first callers.
 * 3. Retries on init failure (does NOT permanently cache the failure).
 *
 * The `_setZstdImporter` / `_zstdInitCount` internal hooks make the module-private
 * singleton observable so these are real assertions, not behavioral guesses.
 */

/** Generate deterministic test bytes. */
function makeBytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = (i * 37 + 13) & 0xff;
  }
  return arr;
}

afterEach(() => {
  // Restore the real fzstd importer + reset counters so tests do not leak state.
  _setZstdImporter();
});

describe('zstd deferred-init singleton (w5)', () => {
  it('AC-12 zero-cost: importer is not invoked until the first decompress call', () => {
    _setZstdImporter(); // reset counter to 0
    expect(typeof decompressZstd).toBe('function');
    // Importing / referencing the function must not have loaded the decompressor.
    expect(_zstdInitCount()).toBe(0);
  });

  it('first call to decompressZstd triggers init exactly once and decompresses correctly', async () => {
    _setZstdImporter();
    const input = makeBytes(256);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    const result = await decompressZstd(comp.value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('decompress failed');
    expect(result.value).toEqual(input);
    expect(_zstdInitCount()).toBe(1);
  });

  it('N concurrent first calls share a single init (importer invoked once) (AC-12)', async () => {
    // Inject a slow importer so all 5 calls race while init is still in-flight.
    const realFzstd = await import('fzstd');
    _setZstdImporter(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(realFzstd.decompress), 10);
        }),
    );

    const input = makeBytes(256);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    const results = await Promise.all(Array.from({ length: 5 }, () => decompressZstd(comp.value)));

    // The importer must have been invoked exactly once despite 5 concurrent callers.
    expect(_zstdInitCount()).toBe(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('decompress failed');
      expect(r.value).toEqual(input);
    }
  });

  it('init failure returns codec-init-failed and the next call retries (not permanently cached)', async () => {
    let attempts = 0;
    const realFzstd = await import('fzstd');
    _setZstdImporter(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('simulated fzstd load failure'));
      }
      return Promise.resolve(realFzstd.decompress);
    });

    const input = makeBytes(128);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    // First call: importer rejects -> codec-init-failed, cached failure cleared.
    const failed = await decompressZstd(comp.value);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('expected first call to fail');
    expect(failed.error.code).toBe('codec-init-failed');

    // Second call: importer retried (not permanently cached) -> succeeds.
    const retried = await decompressZstd(comp.value);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('retry decompress failed');
    expect(retried.value).toEqual(input);
    expect(attempts).toBe(2);
  });
});
