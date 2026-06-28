// ddc-cache.ts -- content-addressed build-time Derived Data Cache for the
// decoded RGBA bytes that `importTextureEntry` produces
// (tweak-20260627-model-loading-smoke-build-perf M2 / m2-1, plan-strategy
// D-1 / D-2).
//
// Why this exists: `generateBundle` (index.ts) decodes ~200 image subAssets
// into ~787MB raw RGBA on EVERY build (~76s of the 102s model-loading smoke
// CI step). The decode is deterministic for a given (source bytes, import
// settings), so caching the decoded OUTPUT lets a warm build skip
// `imageImporter.import` entirely.
//
// D-1 (seam): we cache the DECODED bytes + metadata -- the expensive INPUT to
// `emitFile` -- NOT the emitted `dist/assets/<guid>-<hash>.bin`. Every cache
// hit still flows through `emitFile` + `getFileName` in the caller, so hashed
// names and `pack-index.json` stay byte-identical to a cold build.
//
// D-2 (content-addressed): the cache key is `sha256(sourceBytes)` combined
// with `sha256(stableSerialize(importSettings))`. The hash IS the filename,
// so "stale" is unrepresentable -- presence == validity. A changed source or
// changed import settings yields a different filename => miss => fresh decode.
// There is NO separate invalidation / mtime concept.
//
// This is a NEW build cache, SEPARATE from the dev DDC (index.ts `ddcPath`,
// bare-guid `<guid>.bin`). It lives under a `build/` subdir so the
// content-hashed filenames never collide with the dev DDC's per-guid files
// (OOS-2). Both sit under `node_modules/.cache/forgeax-ddc` so CI
// `actions/cache` covers them with one path.
//
// Fail-open: every read/write swallows IO errors and degrades to a cold
// decode. The cache is an optional accelerator, never a correctness
// dependency.
//
// Package home (plan-strategy D-6): this lives in the build-time
// `@forgeax/engine-vite-plugin-pack` package, NOT in `packages/runtime/src/`
// (OOS-1 -- `check-image-pipeline-isolation.mjs` forbids the runtime from
// reaching the decoder seam).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImageMetadata } from '@forgeax/engine-types';

/** Decoded texture payload cached under one content-addressed key. */
export interface DdcEntry {
  readonly bytes: Uint8Array;
  readonly metadata: ImageMetadata;
}

/**
 * Derive the content-addressed cache key for one texture decode.
 *
 * The key folds two independent inputs that fully determine the decoded
 * output: the raw source file bytes and the import settings (colorSpace /
 * mipmap / any format-affecting field). A changed source OR a changed setting
 * produces a different key, so a stale hit is impossible (D-2).
 *
 * `importSettings` is serialized with sorted keys so that key order in the
 * object never perturbs the hash (two settings objects with the same entries
 * map to the same key).
 */
export function keyFor(sourceBytes: Uint8Array, importSettings: unknown): string {
  const srcHash = createHash('sha256').update(sourceBytes).digest('hex');
  const settingsHash = createHash('sha256').update(stableSerialize(importSettings)).digest('hex');
  // Combine both into one hash so the filename is a single fixed-length token.
  return createHash('sha256').update(`${srcHash}:${settingsHash}`).digest('hex');
}

/** Deterministic JSON serialization with recursively sorted object keys. */
function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/** Absolute path of the build DDC directory under `node_modules/.cache`. */
function buildCacheDir(cwd: string): string {
  return resolve(cwd, 'node_modules/.cache/forgeax-ddc/build');
}

/**
 * Read a cached decode by key, or `null` on miss / unreadable cache.
 *
 * A hit requires BOTH the `<key>.bin` (decoded bytes) and the `<key>.json`
 * (metadata sidecar) to be present and parseable -- a half-written entry is
 * treated as a miss so the caller re-decodes (fail-open). Reconstructs the
 * full `importTextureEntry` success shape without touching the decoder.
 */
export function read(cwd: string, key: string): DdcEntry | null {
  const dir = buildCacheDir(cwd);
  try {
    const bytes = new Uint8Array(readFileSync(resolve(dir, `${key}.bin`)));
    const metadata = JSON.parse(
      readFileSync(resolve(dir, `${key}.json`), 'utf-8'),
    ) as ImageMetadata;
    return { bytes, metadata };
  } catch {
    return null;
  }
}

/**
 * Persist one decode under its content-addressed key. Fail-open: any IO error
 * (unwritable cache dir, full disk) is swallowed -- the build proceeds with the
 * freshly decoded bytes it already has in hand.
 *
 * The `.json` metadata is written before the `.bin` so a concurrent reader
 * that observes the `.bin` also finds its sidecar (read() requires both).
 */
export function write(cwd: string, key: string, entry: DdcEntry): void {
  const dir = buildCacheDir(cwd);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${key}.json`), JSON.stringify(entry.metadata));
    writeFileSync(resolve(dir, `${key}.bin`), entry.bytes);
  } catch {
    // fail-open: cache is an accelerator, never a correctness dependency.
  }
}
