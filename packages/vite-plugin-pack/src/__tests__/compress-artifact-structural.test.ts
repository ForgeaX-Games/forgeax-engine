/**
 * w10: compress-artifact SSOT structural check (AC-08).
 *
 * Validates that:
 *  - compressArtifact lives in the NEW file compress-artifact.ts, not index.ts (D-7)
 *  - dev `/__import` handler and build `generateBundle` both import the SAME
 *    compressArtifact export (single SSOT, analogous to importTextureEntry)
 *  - the real STRATEGY_TABLE behavior is exercised (mesh -> zstd, texture ->
 *    none, packJson -> none), not a drifting local stand-in
 *
 * D-10: no binary fixtures — assertions are behavioral + source-text analysis.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decompressZstd } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';
import { compressArtifact } from '../compress-artifact.js';

const indexSource = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

describe('compress-artifact SSOT structural check (AC-08)', () => {
  it('D-7: compressArtifact is exported from compress-artifact.ts, not index.ts', () => {
    expect(typeof compressArtifact).toBe('function');
    // index.ts must not re-declare the function — it may only import it.
    expect(indexSource).not.toMatch(/function\s+compressArtifact/);
  });

  it('AC-08: index.ts imports compressArtifact from the single SSOT module', () => {
    expect(indexSource).toMatch(
      /import\s*\{\s*compressArtifact\s*\}\s*from\s*['"]\.\/compress-artifact\.js['"]/,
    );
    // All 4 injection points reference the one imported symbol.
    const uses = indexSource.match(/compressArtifact\s*\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it('mesh -> zstd: real STRATEGY_TABLE compresses and round-trips (M3 flip active)', async () => {
    // A compressible payload (repeated bytes) so zstd meaningfully shrinks it.
    const original = new Uint8Array(4096).fill(7);
    const result = await compressArtifact({
      bytes: original,
      kind: 'mesh',
      isPackJson: false,
    });
    expect(result.compression).toBe('zstd');
    expect(result.compressed.length).toBeLessThan(original.length);
    const back = await decompressZstd(result.compressed);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('decompress failed');
    expect(back.value).toEqual(original);
  });

  it('texture -> none: pass-through (byte-equal, compression none)', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await compressArtifact({
      bytes: original,
      kind: 'texture',
      isPackJson: false,
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(original);
  });

  it('packJson -> none: never compressed regardless of kind (HTTP layer handles it)', async () => {
    const original = new Uint8Array([9, 9, 9]);
    const result = await compressArtifact({
      bytes: original,
      kind: 'mesh',
      isPackJson: true,
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(original);
  });

  it('AC-01 override=none: explicit override beats the mesh->zstd default', async () => {
    const payload = new Uint8Array(2048).fill(5);
    const result = await compressArtifact({
      bytes: payload,
      kind: 'mesh',
      isPackJson: false,
      override: 'none',
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(payload);
  });

  it('AC-01 override=zstd: explicit override beats the texture->none default', async () => {
    const payload = new Uint8Array(2048).fill(5);
    const result = await compressArtifact({
      bytes: payload,
      kind: 'texture',
      isPackJson: false,
      override: 'zstd',
    });
    expect(result.compression).toBe('zstd');
    expect(result.compressed.length).toBeLessThan(payload.length);
    const back = await decompressZstd(result.compressed);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('decompress failed');
    expect(back.value).toEqual(payload);
  });

  it('AC-01 override + packJson: packJson stays uncompressed even with override=zstd', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const result = await compressArtifact({
      bytes: payload,
      kind: 'mesh',
      isPackJson: true,
      override: 'zstd',
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(payload);
  });
});
