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
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DdcEntryStore, ddcOutputDigest } from '@forgeax/engine-ddc/entry-store';
import { semanticDdcKey as semanticEntryKey } from '@forgeax/engine-ddc/key';
import type { ImageMetadata } from '@forgeax/engine-types';
import type { LogicalArtifactBody, LogicalPackage } from './package-finalizer.js';

/** Decoded texture payload cached under one content-addressed key. */
export interface DdcEntry {
  readonly bytes: Uint8Array;
  readonly metadata: ImageMetadata;
}

export interface DdcMetrics {
  readonly hitCount: number;
  readonly missCount: number;
  readonly writeFailureCount: number;
}

let ddcHitCount = 0;
let ddcMissCount = 0;
let ddcWriteFailureCount = 0;

export function readDdcMetrics(): DdcMetrics {
  return {
    hitCount: ddcHitCount,
    missCount: ddcMissCount,
    writeFailureCount: ddcWriteFailureCount,
  };
}

export function resetDdcMetrics(): void {
  ddcHitCount = 0;
  ddcMissCount = 0;
  ddcWriteFailureCount = 0;
}

export interface SemanticDdcInput {
  readonly schemaVersion: string;
  readonly importerVersion: string;
  readonly codecVersion: string;
  readonly sourceDependencies: readonly (
    | string
    | { readonly path: string; readonly digest: string }
  )[];
  readonly settings: unknown;
  readonly declaredGuids: readonly string[];
  readonly cookProfile: string;
  readonly publish?: unknown;
}

interface SerializedLogicalArtifact {
  readonly mediaType: string;
  readonly assetCodec?: unknown;
  readonly bytes: string;
}

interface SerializedLogicalAsset {
  readonly artifacts: Readonly<Record<string, SerializedLogicalArtifact>>;
  readonly [key: string]: unknown;
}

interface SerializedLogicalPackage {
  readonly schemaVersion: string;
  readonly kind: string;
  readonly assets: readonly SerializedLogicalAsset[];
  readonly [key: string]: unknown;
}

/**
 * Resolve the one repository DDC root shared by all apps in a workspace.
 *
 * A caller outside a pnpm workspace still gets a local cache, but there is no
 * second configuration knob: the nearest workspace file wins.
 */
export function resolveDdcRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return join(current, 'node_modules/.cache/forgeax-ddc');
    }
    const parent = dirname(current);
    if (parent === current) return join(resolve(cwd), 'node_modules/.cache/forgeax-ddc');
    current = parent;
  }
}

/** Hash actual implementation artifacts rather than a manually bumped token. */
export function implementationFingerprint(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(path.replaceAll('\\', '/'));
    hash.update('\0');
    try {
      hash.update(readFileSync(path));
    } catch {
      // A missing implementation artifact is deliberately part of the
      // fingerprint. The next successful build gets a different key.
      hash.update('<missing>');
    }
  }
  return `sha256:${hash.digest('hex')}`;
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

/** Derive a DDC key from semantic cook inputs, excluding publish environment. */
export function semanticDdcKey(input: SemanticDdcInput): string {
  return semanticEntryKey({
    schemaVersion: input.schemaVersion,
    importer: input.importerVersion,
    codec: input.codecVersion,
    settings: input.settings,
    sourceBytes: input.sourceDependencies
      .map((dependency) => (typeof dependency === 'string' ? dependency : dependency.digest))
      .sort()
      .map((digest) => new TextEncoder().encode(digest)),
    declaredGuids: input.declaredGuids,
    targetProfile: input.cookProfile,
    producer: input.importerVersion,
  });
}

export interface LogicalDdcCache {
  readonly key: (input: SemanticDdcInput) => string;
  readonly read: (input: SemanticDdcInput) => Promise<LogicalPackage | null>;
  readonly write: (input: SemanticDdcInput, logicalPackage: LogicalPackage) => Promise<void>;
}

export function createLogicalDdcCache(cwd: string): LogicalDdcCache {
  return {
    key: semanticDdcKey,
    async read(input) {
      return readLogical(cwd, semanticDdcKey(input));
    },
    async write(input, logicalPackage) {
      await writeLogical(cwd, semanticDdcKey(input), logicalPackage);
    },
  };
}

function store(cwd: string): DdcEntryStore {
  return new DdcEntryStore(resolve(cwd, 'node_modules/.cache/forgeax-ddc'));
}

function serialiseLogicalPackage(logicalPackage: LogicalPackage): SerializedLogicalPackage {
  return {
    ...logicalPackage,
    assets: logicalPackage.assets.map((asset) => ({
      ...asset,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts).map(([key, artifact]) => [
          key,
          {
            mediaType: artifact.mediaType,
            ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
            bytes: Buffer.from(artifact.bytes).toString('base64'),
          },
        ]),
      ),
    })),
  } as SerializedLogicalPackage;
}

function readLogicalArtifact(artifact: {
  mediaType: string;
  assetCodec?: unknown;
  bytes: string;
}): LogicalArtifactBody {
  const decoded = {
    mediaType: artifact.mediaType,
    bytes: new Uint8Array(Buffer.from(artifact.bytes, 'base64')),
  };
  if (artifact.assetCodec === undefined || artifact.assetCodec === null) return decoded;
  return {
    ...decoded,
    assetCodec: artifact.assetCodec as { name: string; profile?: string; version?: string },
  };
}

/** Read a logical package cache entry; malformed or partial entries are misses. */
export async function readLogical(cwd: string, key: string): Promise<LogicalPackage | null> {
  try {
    const entry = await store(cwd).read(key);
    if (entry === null) return null;
    const raw = entry.payload as SerializedLogicalPackage;
    if (raw.schemaVersion !== '2.0.0' || raw.kind !== 'internal-text-package') return null;
    return {
      ...raw,
      assets: raw.assets.map((asset) => ({
        ...asset,
        artifacts: Object.fromEntries(
          Object.entries(asset.artifacts).map(([artifactKey, artifact]) => [
            artifactKey,
            readLogicalArtifact(artifact),
          ]),
        ),
      })),
    } as unknown as LogicalPackage;
  } catch {
    ddcMissCount += 1;
    return null;
  }
}

/** Persist only logical bodies. IO failures degrade to a cache miss. */
export async function writeLogical(
  cwd: string,
  key: string,
  logicalPackage: LogicalPackage,
): Promise<void> {
  try {
    const payload = serialiseLogicalPackage(logicalPackage);
    const base = {
      key,
      guid: key,
      payload,
      refs: [],
      artifacts: {},
      receipt: {
        guid: key,
        key,
        producer: 'vite-plugin-pack/logical',
        inputFingerprint: key,
        outputDigest: '',
      },
    } as const;
    await store(cwd).write({
      ...base,
      receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
    });
  } catch {
    ddcWriteFailureCount += 1;
    // DDC is an accelerator and must not become a correctness dependency.
  }
}

/**
 * Read a cached decode by key, or `null` on miss / unreadable cache.
 *
 * The shared DdcEntryStore publishes the bytes and metadata in one immutable
 * entry, so a reader cannot observe a half-written pair.
 */
export async function read(cwd: string, key: string): Promise<DdcEntry | null> {
  try {
    const entry = await store(cwd).read(key);
    if (entry === null) return null;
    const artifact = entry.artifacts.payload;
    if (artifact === undefined) return null;
    return { bytes: artifact.bytes, metadata: entry.payload as ImageMetadata };
  } catch {
    ddcMissCount += 1;
    return null;
  }
}

/**
 * Persist one decode under its content-addressed key. Fail-open: any IO error
 * (unwritable cache dir, full disk) is swallowed -- the build proceeds with the
 * freshly decoded bytes it already has in hand.
 *
 */
export async function write(cwd: string, key: string, entry: DdcEntry): Promise<void> {
  try {
    const base = {
      key,
      guid: key,
      payload: entry.metadata,
      refs: [],
      artifacts: { payload: { mediaType: 'application/octet-stream', bytes: entry.bytes } },
      receipt: {
        guid: key,
        key,
        producer: 'vite-plugin-pack/image',
        inputFingerprint: key,
        outputDigest: '',
      },
    } as const;
    await store(cwd).write({
      ...base,
      receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
    });
  } catch {
    ddcWriteFailureCount += 1;
    // fail-open: cache is an accelerator, never a correctness dependency.
  }
}

/** Remove abandoned atomic-write directories; never remove a completed entry. */
export function cleanDdcTemps(cwd: string): void {
  for (const namespace of ['texture-v2', 'logical-v1']) {
    const directory = join(resolveDdcRoot(cwd), namespace);
    try {
      for (const name of readdirSync(directory)) {
        if (name.startsWith('.'))
          rmSync(resolve(directory, name), { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best effort and must not affect a build.
    }
  }
}
