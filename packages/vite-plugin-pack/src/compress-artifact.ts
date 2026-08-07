/**
 * compress-artifact.ts — shared SSOT for asset compression (AC-08).
 *
 * Single compression function shared by both dev `/__import` handler and
 * build `generateBundle` hook (analogous to `importTextureEntry` pattern
 * at import-texture.ts:76).
 *
 * Plan decisions:
 *   D-3: compression occurs AFTER DDC cache (cached bytes = decoded RGBA).
 *   D-6: M2 default strategy is ALL 'none' (M3 flips mesh → 'zstd' at w20).
 *   D-7: this lives in a NEW file, not in index.ts (index.ts is 1455 lines,
 *        45 from the cohesion threshold of 1500).
 */

import type { CodecResult } from '@forgeax/engine-codec';
import type { AssetCompression } from '@forgeax/engine-types';

/** Artifact kind for compression strategy lookup. */
type ArtifactKind = 'mesh' | 'texture';

/** Options passed to compressArtifact at each injection point. */
export interface CompressArtifactOpts {
  readonly bytes: Uint8Array;
  readonly kind: ArtifactKind;
  readonly isPackJson: boolean;
  /**
   * Explicit per-asset compression override from `.meta.json` importSettings
   * (AC-01). When set, wins over the default STRATEGY_TABLE for this asset;
   * when omitted, the kind-keyed default decides. `.pack.json` is never
   * compressed regardless (HTTP transport layer handles it).
   */
  readonly override?: AssetCompression;
  /**
   * The resolved delivery encoding already baked into `bytes` by the importer
   * (feat-20260707 M6). When this is a `basis-*` member the bytes are a
   * self-supercompressed Basis KTX2: it carries its own supercompression and
   * MUST NOT stack an outer `'zstd'` layer (D-3 mutual exclusion). The row must
   * then record that `basis-*` discriminant so the runtime loader dispatches on
   * the transcode arm rather than the raw-KTX2 path. `'none'` / `'zstd'` /
   * `undefined` leave the STRATEGY_TABLE + override logic below untouched.
   */
  readonly alreadyCompressed?: AssetCompression;
}

function isBasisCompression(c: AssetCompression | undefined): boolean {
  return c === 'basis-etc1s' || c === 'basis-uastc' || c === 'basis-uastc-hdr';
}

/** Return value: compressed bytes + the compression strategy actually used. */
export interface CompressArtifactResult {
  readonly compressed: Uint8Array;
  readonly compression: AssetCompression;
}

/**
 * Internal strategy table — D-6: M2 defaults ALL 'none'.
 * M3 w20 flips mesh → 'zstd'.
 */
const STRATEGY_TABLE: Record<ArtifactKind, AssetCompression> = {
  mesh: 'zstd',
  texture: 'none',
};

/**
 * Shared SSOT compression function.
 *
 * Called after DDC cache (for textures) / packMeshBin (for meshes),
 * before writeFile (dev) / emitFile (build).
 *
 * At M2 all calls produce pass-through (compression='none'), but the wiring
 * is real and tested via w11 round-trip tests using the codec directly.
 * M3 w20 will flip mesh → 'zstd' in STRATEGY_TABLE.
 */
export async function compressArtifact(
  opts: CompressArtifactOpts,
): Promise<CompressArtifactResult> {
  // The importer already produced a self-supercompressed Basis KTX2: pass the
  // bytes through untouched and record the resolved basis-* discriminant on the
  // row so the runtime loader takes the transcode arm (D-3: no outer zstd layer
  // stacks on a Basis container; the row compression must be the basis-* member,
  // never the STRATEGY_TABLE 'none'/'zstd' default). Without this the row landed
  // on 'none', the loader missed its transcode dispatch, and the scheme=1 KTX2
  // hit ktx2LevelsToRGBA which rejects BasisLZ.
  if (isBasisCompression(opts.alreadyCompressed)) {
    return {
      compressed: new Uint8Array(opts.bytes),
      compression: opts.alreadyCompressed as AssetCompression,
    };
  }

  // Explicit per-asset override (AC-01) wins over the kind-keyed default table.
  const strategy: AssetCompression = opts.override ?? STRATEGY_TABLE[opts.kind];

  // .pack.json is never compressed (already gzip/brotli at HTTP layer)
  if (opts.isPackJson || strategy === 'none') {
    return { compressed: new Uint8Array(opts.bytes), compression: 'none' };
  }

  // strategy === 'zstd': call codec encode
  const { compressZstd } = await import('@forgeax/engine-codec/encode');
  const result: CodecResult<Uint8Array> = await compressZstd(opts.bytes);

  if (result.ok) {
    return { compressed: result.value, compression: 'zstd' };
  }

  // On compression failure, fall back to pass-through.
  // This is a soft-failure: the catalog row won't carry compression='zstd'
  // so the runtime fetchBinary will treat it as uncompressed (E1 passthrough).
  // The failure is not propagated because this is build-time — a broken
  // zstd library should not block the entire asset pipeline.
  // detail is CodecErrorDetails[CodecErrorCode]; the real detail carries
  // 'reason' for decompression-failed, 'stage' for codec-init-failed, etc.
  // We extract a best-effort reason string via the union's shared properties.
  const errorReason: string =
    'reason' in result.error.detail && typeof result.error.detail.reason === 'string'
      ? result.error.detail.reason
      : String(result.error.code);
  console.warn(
    `[forgeax-pack] compressArtifact: zstd compression failed (${errorReason}), falling back to pass-through`,
  );
  return { compressed: new Uint8Array(opts.bytes), compression: 'none' };
}
