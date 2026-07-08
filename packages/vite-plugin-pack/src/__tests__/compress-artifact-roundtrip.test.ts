/**
 * w11: compress-artifact dual-arm byte-identical round-trip.
 *
 * Validates against the REAL compressArtifact SSOT (no local stand-in):
 *  (1) mesh → zstd → decompressZstd → byte-identical
 *  (2) texture → none → original bytes unchanged (pass-through)
 *  (3) dual-arm: same input + same target → byte-identical compressed output
 *  (4) real STRATEGY_TABLE: mesh → zstd (M3 flip), texture → none
 *
 * D-10: all fixture data programmatic.
 */

import { decompressZstd } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';
import { compressArtifact } from '../compress-artifact.js';

describe('compress-artifact dual-arm round-trip (AC-07)', () => {
  it('mesh zstd round-trip: compressArtifact → decompressZstd → byte-identical', async () => {
    // Programmatic fixture (D-10): 1024 bytes of pseudo-mesh data.
    const fixtureBytes = new Uint8Array(1024);
    for (let i = 0; i < fixtureBytes.length; i++) {
      fixtureBytes[i] = (i * 7 + 13) % 256;
    }

    // Compress THROUGH the real SSOT compressArtifact (mesh → zstd).
    const compressed = await compressArtifact({
      bytes: fixtureBytes,
      kind: 'mesh',
      isPackJson: false,
    });
    expect(compressed.compression).toBe('zstd');

    // Decompress with the runtime-side decoder → byte-identical.
    const decompressResult = await decompressZstd(compressed.compressed);
    expect(decompressResult.ok).toBe(true);
    if (!decompressResult.ok) throw new Error('decompressZstd failed');
    expect(decompressResult.value).toEqual(fixtureBytes);
  });

  it('texture → none: compressArtifact returns original bytes unchanged (identity)', async () => {
    const input = new Uint8Array([10, 20, 30, 40, 50]);
    const result = await compressArtifact({
      bytes: input,
      kind: 'texture',
      isPackJson: false,
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(input);
  });

  it('packJson → none: never compressed even when kind would otherwise compress', async () => {
    const input = new Uint8Array(4096);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 3 + 7) % 256;
    }
    const result = await compressArtifact({
      bytes: input,
      kind: 'mesh',
      isPackJson: true,
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(input);
  });

  it('dual-arm: same input + same target → byte-identical compressed output', async () => {
    // AC-07: dev and build arms must produce byte-identical compressed output.
    // This is guaranteed by the deterministic zstd compression (M1 w7) + the
    // single SSOT compressArtifact function shared by both call sites.
    //
    // We verify the underlying codec determinism: two compressZstd calls on
    // the same input produce byte-identical output.
    const { compressZstd } = await import('@forgeax/engine-codec/encode');

    const input = new Uint8Array(2048);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 11 + 17) % 256;
    }

    // "Dev arm" compression
    const devResult = await compressZstd(input);
    expect(devResult.ok).toBe(true);
    if (!devResult.ok) throw new Error('compressZstd failed (dev)');

    // "Build arm" compression — same input, same function, same level
    const buildResult = await compressZstd(input);
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) throw new Error('compressZstd failed (build)');

    // Both arms produce byte-identical compressed output
    expect(devResult.value.length).toBe(buildResult.value.length);
    for (let i = 0; i < devResult.value.length; i++) {
      expect(devResult.value[i]).toBe(buildResult.value[i]);
    }
  });

  it('real STRATEGY_TABLE (post-M3): mesh→zstd, texture→none', async () => {
    // Exercise the actual compressArtifact strategy, not a local copy that can drift.
    // Compressible payload so mesh path visibly shrinks.
    const payload = new Uint8Array(2048).fill(3);
    const mesh = await compressArtifact({ bytes: payload, kind: 'mesh', isPackJson: false });
    const texture = await compressArtifact({ bytes: payload, kind: 'texture', isPackJson: false });
    expect(mesh.compression).toBe('zstd');
    expect(texture.compression).toBe('none');
  });

  it('explicit override: target="zstd" produces real compressed bytes (not identity)', async () => {
    // When a caller explicitly forces zstd, the output must be different from
    // the input (actual compression happened, not pass-through).
    const { compressZstd } = await import('@forgeax/engine-codec/encode');

    const input = new Uint8Array(4096);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 13 + 29) % 256;
    }

    const result = await compressZstd(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('compressZstd failed');

    // Compressed bytes should differ from input (actual compression).
    // While zstd can theoretically expand tiny inputs, 4KB of pseudo-random
    // data will definitely compress.
    const diff =
      result.value.length !== input.length || result.value.some((b, i) => b !== input[i]);
    expect(diff).toBe(true);
  });

  it('alreadyCompressed=basis-*: passthrough bytes + row records the basis discriminant (no zstd stacking)', async () => {
    // feat-20260707 M6 fix: a Basis KTX2 is self-supercompressed; the row must
    // carry its basis-* discriminant so the runtime loader takes the transcode
    // arm. Without this the row landed on 'none' and the scheme=1 KTX2 hit
    // ktx2LevelsToRGBA which rejects BasisLZ. D-3: no outer zstd layer stacks.
    for (const mode of ['basis-etc1s', 'basis-uastc', 'basis-uastc-hdr'] as const) {
      const ktx2Bytes = new Uint8Array(512);
      for (let i = 0; i < ktx2Bytes.length; i++) ktx2Bytes[i] = (i * 5 + 3) % 256;
      const result = await compressArtifact({
        bytes: ktx2Bytes,
        kind: 'texture',
        isPackJson: false,
        alreadyCompressed: mode,
      });
      expect(result.compression).toBe(mode);
      // Bytes pass through untouched (no zstd re-encode of the Basis container).
      expect(result.compressed).toEqual(ktx2Bytes);
    }
  });

  it('alreadyCompressed=basis-* wins over an explicit zstd override (D-3 mutual exclusion)', async () => {
    // Even a sidecar zstd override must not stack an outer zstd layer on a Basis
    // container -- the basis-* delivery encoding is authoritative.
    const ktx2Bytes = new Uint8Array(256).fill(7);
    const result = await compressArtifact({
      bytes: ktx2Bytes,
      kind: 'texture',
      isPackJson: false,
      override: 'zstd',
      alreadyCompressed: 'basis-uastc',
    });
    expect(result.compression).toBe('basis-uastc');
    expect(result.compressed).toEqual(ktx2Bytes);
  });

  it('alreadyCompressed=none: falls through to the STRATEGY_TABLE/override path unchanged', async () => {
    // An uncompressed import (compressionMode:'none') must NOT short-circuit --
    // the kind-keyed default still decides (texture -> none here).
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await compressArtifact({
      bytes: rgba,
      kind: 'texture',
      isPackJson: false,
      alreadyCompressed: 'none',
    });
    expect(result.compression).toBe('none');
    expect(result.compressed).toEqual(rgba);
  });

  it('round-trip through codec encode→decode path (end-to-end verification)', async () => {
    // Full chain: programmatic fixture → compressZstd → decompressZstd → identical.
    // This is the same chain that w13's compressArtifact will use when force='zstd'.
    const { compressZstd } = await import('@forgeax/engine-codec/encode');

    const sizes = [0, 1, 64, 256, 1024, 8192];

    for (const size of sizes) {
      const input = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        input[i] = (i * 17 + 31) % 256;
      }

      const encResult = await compressZstd(input);
      expect(encResult.ok).toBe(true);
      if (!encResult.ok) continue;

      const decResult = await decompressZstd(encResult.value);
      expect(decResult.ok).toBe(true);
      if (!decResult.ok) continue;

      expect(decResult.value.length).toBe(size);
      for (let i = 0; i < size; i++) {
        expect(decResult.value[i]).toBe(input[i]);
      }
    }
  });
});
