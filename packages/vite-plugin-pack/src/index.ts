// @forgeax/engine-vite-plugin-pack — Vite plugin for the forgeax engine asset package system.
//
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  IMPORT_ERROR_HINTS,
  ImportError,
  ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import { loadAssetConfig } from '@forgeax/engine-pack/config';
import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { resolveAssetSource } from '@forgeax/engine-pack/resolve';
import type { Importer, PackIndexEntry } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { projectAssetProduction } from './build/asset-production.js';
import {
  buildCatalogProjection,
  type CatalogLegacyProjection,
  currentProjectionFor,
} from './build-catalog.js';
import { type AssetHostRefreshPolicy, CATALOG_DELTA_EVENT } from './catalog-client.js';
import { calculateCatalogDelta } from './catalog-watch.js';
import { compressArtifact } from './compress-artifact.js';
import { readDdcMetrics, resolveDdcRoot, semanticDdcKey } from './ddc-cache.js';
import { createAssetChangedEvent, emitAssetChanged } from './dev/asset-change-events.js';
import { publishImportPublication } from './dev/import-publication.js';
import { createPackageRoutes } from './dev/package-routes.js';
import { createUiDependencyIndex } from './dev/ui-dependency-index.js';
import {
  buildGuidToMetaMap,
  buildUrlToAbsolute,
  type WatchBatch,
  watchDevRoots,
} from './dev/watcher.js';
import {
  productAssetByGuid,
  productAssetsByGuid,
  productBinaryArtifacts,
  projectUiBuildArtifacts,
} from './import-products.js';
import { importTextureEntry } from './import-texture.js';
import {
  finalizePackage,
  type LogicalPackage,
  type LogicalPackageAsset,
} from './package-finalizer.js';
import {
  loadSharedPackInput,
  projectPackIndexUrl,
  projectSharedPackCatalog,
  resolvePackBuildInputs,
} from './shared-build-inputs.js';
import { dedupeFinalizedUiEntries, finalizeUiArtifact } from './ui-pack-finalizer.js';

export {
  type AssetProductionProjection,
  projectAssetProduction,
} from './build/asset-production.js';
export { CATALOG_DELTA_EVENT, createCatalogClient, reloadAssetHost } from './catalog-client.js';
export { ASSET_CHANGED_EVENT, type AssetChangedPayload } from './dev/events.js';
export {
  createMaterialCookFinalizer,
  type MaterialArtifactSink,
  type MaterialCookCatalogEntry,
  type MaterialCookFinalizerOptions,
  type MaterialCookRequest,
  writeMaterialCookResult,
} from './material/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

// PackIndexEntry now lives in @forgeax/engine-types (feat-20260517 D-2 SSOT).
// Re-export so existing consumers (tests, downstream packages) keep their
// `import { PackIndexEntry } from '@forgeax/engine-vite-plugin-pack'` paths
// working without a same-PR API break.
export type { PackIndexEntry };

/** Preserve the published Catalog LKG while a source is invalidated. */
export function preserveInvalidatedCatalogLkg(
  previousCatalog: readonly PackIndexEntry[],
  nextCatalog: readonly PackIndexEntry[],
  invalidatedGuids: ReadonlySet<string>,
): PackIndexEntry[] {
  const previousByGuid = new Map(previousCatalog.map((row) => [row.guid.toLowerCase(), row]));
  return nextCatalog.map((row) => {
    const previous = previousByGuid.get(row.guid.toLowerCase());
    const previousLkg = previous?.projection?.lastKnownGood?.packageUrl;
    if (
      row.projection === undefined ||
      (!invalidatedGuids.has(row.guid.toLowerCase()) && previousLkg === undefined)
    ) {
      return row;
    }
    const lastKnownGood =
      previousLkg ?? (previous?.lifecycle === 'current' ? previous.packageUrl : undefined);
    if (lastKnownGood === undefined) return row;
    return {
      ...row,
      projection: {
        ...row.projection,
        lastKnownGood: { packageUrl: lastKnownGood },
      },
    };
  });
}

const COOKED_CURRENT_PROJECTION = {
  ...currentProjectionFor('imported-output', 'cooked'),
};

const DIRECT_CURRENT_PROJECTION = {
  ...currentProjectionFor('internal-asset', 'direct'),
};

const AUTHORED_COOKED_CURRENT_PROJECTION = {
  ...currentProjectionFor('internal-asset', 'cooked'),
};

// Minimal structural interface for Vite Plugin (duck-typed; no vite import needed).
//
// `emitFile` covers two Rollup variants we use here:
//   - text asset:  `{ type: 'asset', fileName: 'pack-index.json', source: '...' }`
//     -> emitted at the explicit path with no hash (used for the catalog index).
//   - binary asset: `{ type: 'asset', name: '<guid>', source: <Uint8Array>,
//     originalFileName: <abs-jpg-path> }` -> Rollup picks
//     `assets/[name]-[hash][extname]` by default (D-2). We capture the
//     returned `referenceId` and resolve the hashed filename via
//     `getFileName(referenceId)` once Rollup has finished name resolution
//     (research F1+F3).
interface MinimalPluginContext {
  emitFile(asset: {
    type: 'asset';
    fileName?: string;
    name?: string;
    originalFileName?: string;
    source: string | Uint8Array;
  }): string;
  getFileName(referenceId: string): string;
}

type NextHandleFunction = (err?: unknown) => void;

interface ServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

interface IncomingMessageLike {
  readonly url?: string | undefined;
}

type ConnectMiddleware = (
  req: IncomingMessageLike,
  res: ServerResponseLike,
  next: NextHandleFunction,
) => void | Promise<void>;

interface MiddlewaresLike {
  use(handler: ConnectMiddleware): unknown;
}

interface ViteDevServerLike {
  readonly middlewares: MiddlewaresLike;
  readonly ws?: WsLike | undefined;
}

interface WsLike {
  send(payload: { type: string } & Record<string, unknown>): void;
}

/** Shape of the plugin returned by pluginPack(). */
export interface ForgeaXPackPlugin {
  readonly name: string;
  configureServer(server: ViteDevServerLike): void;
  generateBundle(this: MinimalPluginContext): Promise<void>;
  writeBundle(options: { readonly dir?: string | undefined }): Promise<void>;
  closeBundle(): Promise<void>;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface PluginPackOptions {
  /**
   * Root directories to scan for .meta.json / .pack.json files.
   * Defaults to ["assets/"] relative to cwd; reads from root
   * package.json#forgeax.assets.roots[] when present.
   */
  readonly roots?: readonly string[] | undefined;
  /**
   * Vite `base` the engine is hosted under (e.g. `'/preview/'` when
   * forgeax-studio mounts the engine behind its `/preview/*` proxy).
   * Prefixed onto every catalog `packageUrl` so the runtime's verbatim
   * `fetch(packageUrl)` from the page origin reaches the engine instead of
   * the host SPA (which would return index.html → `asset-fetch-failed`).
   * Defaults to `'/'` (engine's own apps at vite root) — a no-op prefix.
   */
  readonly base?: string | undefined;
  /**
   * M4 / w32 (AC-20): registered `Importer` instances the lazy-import
   * HTTP adapter (`POST /__import/:guid`) dispatches on `meta.importer`.
   * Each importer must carry a non-empty `key` + a `import` function.
   * When `undefined` or `[]`, the `POST /__import/:guid` route is not
   * mounted (dev-only lazy import is disabled).
   */
  readonly importers?: readonly Importer[] | undefined;
  /** Native authored-Pack producers. Cooked Pack rows fail fast without one. */
  readonly cookers?: readonly NativeCooker[] | undefined;
  /** Host-owned reaction to a real watched-byte change; absent means no reload. */
  readonly refresh?: AssetHostRefreshPolicy | undefined;
}

// ─── Config loading ──────────────────────────────────────────────────────────

// ─── Catalog builder ────────────────────────────────────────────────────────
// buildCatalog is extracted into ./build-catalog.ts so its 2 arms
// (`.pack.json` legacy + `.meta.json` image) stay reviewable in one
// file (feat-20260517 M1 w3). The factory below imports it for both the
// dev-mode middleware and the build-mode generateBundle hook.

// ─── Mime sniff ─────────────────────────────────────────────────────────────

function mimeFromPath(path: string): 'image/jpeg' | 'image/png' | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return undefined;
}

// Dev import DDC (Derived Data Cache) location. The imported `.bin` is derived
// data -- delete it and the next `loadByGuid` re-derives it from the source.
// Keying it by GUID under `node_modules/.cache/forgeax-ddc/` keeps it gitignored
// everywhere (root `node_modules/` rule) so it never pollutes the source tree,
// which for vendor assets (e.g. Sponza textures) is a tracked git submodule.
// Deterministic from `(cwd, guid)`: the write site (importOneTexture) and the
// warm-refresh reconstruction site (buildUrlToAbs) MUST agree on this formula.
// GUIDs are globally unique (UUIDv5/v7 per sub-asset), so no collision with the
// build arm's `dist/assets/<guid>-<hash>.bin` Rollup namespace.
function ddcPath(cwd: string, guidLower: string): string {
  return resolve(resolveDdcRoot(cwd), `${guidLower}.bin`);
}

/**
 * AC-01: read an explicit per-asset compression override from a meta sidecar's
 * `importSettings.compression`. Returns the narrowed union value, or undefined
 * when absent / malformed (falls back to the kind-keyed default table).
 */
function readCompressionOverride(importSettings: unknown): 'none' | 'zstd' | undefined {
  if (importSettings === null || typeof importSettings !== 'object') return undefined;
  const c = (importSettings as { compression?: unknown }).compression;
  return c === 'none' || c === 'zstd' ? c : undefined;
}

/**
 * AC-01: read the explicit compression override from a meta sidecar path (used
 * by the texture arms, which reach compression via `importTextureEntry` and do
 * not otherwise parse the meta). Returns undefined when the path is unknown /
 * unreadable / has no override.
 */
async function readOverrideFromMeta(
  metaPath: string | undefined,
): Promise<'none' | 'zstd' | undefined> {
  if (metaPath === undefined) return undefined;
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { importSettings?: unknown };
    return readCompressionOverride(meta.importSettings);
  } catch {
    return undefined;
  }
}

// ─── Main factory ───────────────────────────────────────────────────────────

/** Vite plugin factory for the ForgeaX asset package system. */
export function pluginPack(opts: PluginPackOptions = {}): ForgeaXPackPlugin {
  // Mutable catalog state — rebuilt on startup and on file watch events.
  let catalog: PackIndexEntry[] = [];
  let catalogProjection: CatalogLegacyProjection = {
    schemaVersion: 'catalog-legacy-v1',
    entries: [],
    authority: 'authoritative',
    diagnostics: [],
  };
  // Map from normalized `packageUrl` to absolute source path for serving
  // files that live outside the Vite root (e.g. submodule assets).
  let urlToAbs: Map<string, string> = new Map();
  let catalogReady = false;
  let publishCatalogDelta:
    | ((delta: import('@forgeax/engine-types').CatalogDelta) => void)
    | undefined;

  // M4 / w32 (AC-20): GUID -> meta-path index built alongside the catalog so
  // `POST /__import/:guid` can find the declaring meta sidecar. Rebuilt on
  // every catalog rebuild (startup + watch events).
  let guidToMeta: Map<string, string> = new Map();
  const uiDependencies = createUiDependencyIndex();

  // Per-asset import overlay (the four-verb redesign, 2026-06-06). A dev import
  // produces ONE imported `.bin` row and records it here keyed by lowercased
  // GUID. Every catalog (re)build overlays these rows over the freshly scanned
  // raw rows so an imported row is NEVER reset back to its raw source -- import
  // is monotonic and idempotent. This replaces #300's whole-catalog rebuild +
  // swap in `POST /__import`, which raced under concurrent load (122 Sponza
  // textures each swapping a freshly-rebuilt catalog that knew only its own
  // `.bin`, so every other texture's imported row was reset to raw and import
  // never converged).
  const importedRows: Map<string, PackIndexEntry> = new Map();

  // In-flight import coalescing: two concurrent `loadByGuid` calls for the same
  // texture share a single import promise (per-asset idempotency at the verb
  // boundary -- `import(guid)` is the unit, not "rebuild the world").
  const inFlightImports: Map<string, Promise<PackIndexEntry[]>> = new Map();

  // M4 / w20 (D-2): per-meta import coalescing. Two concurrent `loadByGuid`
  // calls hitting the same meta sidecar share a single `runImport` pass.
  // Keyed by absolute metaPath; the promise resolves to the full set of
  // PackIndexEntry rows produced by that meta's import. On completion the
  // entry is deleted so a subsequent sidecar-triggered rebuild can re-import.
  // This reduces the 122-concurrent-Sponza-texture case from 122 decodes to
  // 1 decode (per meta), matching the build-mode `generateBundle` single-pass
  // behaviour (requirements AC-15).
  const inFlightMetaImports: Map<string, Promise<PackIndexEntry[]>> = new Map();

  // bug-20260610-dev-meta-pack-not-served: in-memory store for `.pack.json`
  // bodies produced by `startMetaImport`. Keys are dev URLs of the form
  // `/__forgeax-ddc/<firstGuid>.pack.json`; values are the serialised pack
  // JSON. Mesh / scene / material sub-asset rows whose payloads live inside
  // the pack (no separate `.bin`) get their `packageUrl` rewritten to this
  // URL so the runtime's `fetchPackFile` reaches a body that has `assets[]`,
  // matching the build-mode `generateBundle` behaviour where every sub-asset
  // row points at a hashed `.pack.json` Rollup asset (lines ~1000-1024).
  // Without this map the dev path returned the raw `.gltf` URL for non-binary
  // sub-assets, the runtime fetched the gltf JSON (200 OK), `assets[]` was
  // undefined, and `loadByGuid` failed `asset-not-found` on the first scene /
  // mesh / material lookup.
  const metaPackBodies: Map<string, string> = new Map();
  const devArtifactBodies: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }> =
    new Map();
  const DEV_PACK_PREFIX = '/__forgeax-ddc/';
  const packageRoutes = createPackageRoutes();
  const nativeCookerRegistry = new NativeCookerRegistry();
  for (const cooker of opts.cookers ?? []) nativeCookerRegistry.register(cooker);

  interface AuthoredPackAssetInput {
    readonly guid: string;
    readonly kind: string;
    readonly name?: string;
    readonly execution?: 'direct' | 'cooked';
    readonly payload: Record<string, unknown>;
    readonly refs?: readonly string[];
    readonly artifacts?: Readonly<Record<string, unknown>>;
  }

  interface AuthoredPackInput {
    readonly schemaVersion?: string;
    readonly assets?: readonly AuthoredPackAssetInput[];
  }

  // The checked-in DejaVu font package predates Pack v2: it is a valid
  // internal-text-package with a 1.0.0 envelope and no explicit refs/artifacts.
  // Publish the compatibility projection as Pack v2 at the transport boundary
  // so runtime never has to accept two package contracts. Font refs are derived
  // from the producer-owned atlasGuid/samplerGuid fields; all other legacy refs
  // remain empty because their payload already carries its complete identity.
  function upgradeLegacyAuthoredPack(pack: AuthoredPackInput): AuthoredPackInput {
    if (pack.schemaVersion !== '1.0.0' || pack.assets === undefined) return pack;
    return {
      ...pack,
      schemaVersion: '2.0.0',
      assets: pack.assets.map((asset) => {
        const fontRefs =
          asset.kind === 'font'
            ? [asset.payload.atlasGuid, asset.payload.samplerGuid].filter(
                (guid): guid is string => typeof guid === 'string',
              )
            : [];
        return {
          ...asset,
          refs: asset.refs ?? fontRefs,
          artifacts: asset.artifacts ?? {},
        };
      }),
    };
  }

  interface CookedAuthoredPack {
    readonly logicalPackage: LogicalPackage;
    readonly refsByGuid: ReadonlyMap<string, readonly string[]>;
  }

  async function readCookedAuthoredPack(
    sourcePath: string,
  ): Promise<CookedAuthoredPack | undefined> {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as AuthoredPackInput;
    if (parsed.schemaVersion !== '2.0.0' || parsed.assets === undefined) return undefined;
    const assets: LogicalPackageAsset[] = [];
    const refsByGuid = new Map<string, readonly string[]>();
    let hasCookedAsset = false;
    for (const asset of parsed.assets) {
      if (asset.execution !== 'cooked') {
        assets.push({
          guid: asset.guid,
          kind: asset.kind,
          ...(asset.name === undefined ? {} : { name: asset.name }),
          payload: asset.payload,
          refs: asset.refs ?? [],
          artifacts: {},
        });
        continue;
      }
      hasCookedAsset = true;
      const result = await nativeCookerRegistry.runDraft(asset.kind, {
        guid: asset.guid,
        source: asset.payload,
      });
      if (!result.ok) {
        throw new Error(
          `[forgeax-pack] native cook failed for ${asset.guid}: ${result.error.code} — ${result.error.hint}`,
        );
      }
      const draft = result.value;
      const refs = [...draft.refs];
      refsByGuid.set(asset.guid.toLowerCase(), refs);
      assets.push({
        guid: draft.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        payload: draft.payload as Record<string, unknown>,
        refs,
        artifacts: draft.artifacts,
      });
    }
    if (!hasCookedAsset) return undefined;
    return {
      logicalPackage: {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets,
      },
      refsByGuid,
    };
  }

  // Rollup retains every `emitFile({ source: Uint8Array })` payload until the
  // bundle is rendered. Large cooked textures can therefore turn a correct
  // build into a multi-gigabyte JS heap peak even though each artifact is
  // independent. Stage cooked bytes on disk and move them into the final
  // output after Rollup has written its bundle; pack JSON remains a small
  // Rollup asset and still gets normal output cleanup.
  let buildArtifactStage: { readonly root: string; readonly files: Set<string> } | undefined;

  async function stageBuildArtifact(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
    if (
      normalized.length === 0 ||
      normalized.split('/').some((part) => part === '..' || part.length === 0)
    ) {
      throw new Error(`build artifact path must stay output-relative: ${path}`);
    }
    if (buildArtifactStage === undefined) {
      await mkdir(resolve(process.cwd(), 'node_modules/.cache'), { recursive: true });
      const root = await mkdtemp(resolve(process.cwd(), 'node_modules/.cache/forgeax-pack-'));
      buildArtifactStage = { root, files: new Set() };
    }
    const destination = resolve(buildArtifactStage.root, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    buildArtifactStage.files.add(normalized);
  }

  // Overlay the persistent imported rows over a freshly scanned raw catalog,
  // de-duplicating any stale raw row for a GUID that has been imported (so the
  // imported `.bin` row uniquely wins, e.g. a legacy `.pack.json` duplicate).
  function applyImportedRows(raw: readonly PackIndexEntry[]): PackIndexEntry[] {
    const seen = new Set<string>();
    const out: PackIndexEntry[] = [];
    for (const e of raw) {
      const key = e.guid.toLowerCase();
      const imported = importedRows.get(key);
      if (imported !== undefined) {
        if (!seen.has(key)) {
          out.push(imported);
          seen.add(key);
        }
        continue;
      }
      if (!seen.has(key)) {
        out.push(e);
        seen.add(key);
      }
    }
    return out;
  }

  function installCatalogProjection(projection: CatalogLegacyProjection): void {
    // A degraded snapshot may contain first-seen rows for machine inspection,
    // but those rows are not a usable identity catalog. Keep them only inside
    // the marked projection and fail closed for lookup/import operations.
    const entries =
      projection.authority === 'authoritative' ? applyImportedRows(projection.entries) : [];
    catalog = entries;
    catalogProjection = {
      ...projection,
      ...(projection.authority === 'authoritative' ? { entries } : {}),
    };
  }

  function legacyCatalogResponse(): readonly PackIndexEntry[] | CatalogLegacyProjection {
    return catalogProjection.authority === 'authoritative'
      ? catalogProjection.entries
      : catalogProjection;
  }
  async function publishAuthoredDevPacks(
    raw: readonly PackIndexEntry[],
  ): Promise<PackIndexEntry[]> {
    const published = new Map<string, string>();
    const bodies = new Map<string, string>();
    const cookedRefs = new Map<string, ReadonlyMap<string, readonly string[]>>();
    for (const entry of raw) {
      if (
        !entry.packageUrl.endsWith('.pack.json') ||
        entry.packageUrl.includes(DEV_PACK_PREFIX) ||
        published.has(entry.packageUrl)
      ) {
        continue;
      }
      const sourcePath = resolve(process.cwd(), entry.sourcePath);
      let body: string;
      let pack: AuthoredPackInput;
      try {
        body = readFileSync(sourcePath, 'utf-8');
        pack = upgradeLegacyAuthoredPack(JSON.parse(body) as AuthoredPackInput);
      } catch {
        // buildCatalog reports malformed source packs; leave this row untouched
        // so the existing catalog error remains the visible diagnostic.
        continue;
      }
      const firstGuid = pack.assets?.[0]?.guid?.toLowerCase();
      if (pack.schemaVersion !== '2.0.0' || firstGuid === undefined) continue;
      body = JSON.stringify(pack);
      const cooked = await readCookedAuthoredPack(sourcePath);
      const packageUrl = `${DEV_PACK_PREFIX}${firstGuid}.pack.json`;
      published.set(entry.packageUrl, packageUrl);
      if (cooked === undefined) {
        bodies.set(packageUrl, body);
        continue;
      }
      const finalized = await finalizePackage(
        cooked.logicalPackage,
        {
          write: (path, bytes) => {
            const cleanPath = path.replace(/^\/+/, '');
            if (cleanPath.endsWith('.pack.json')) {
              metaPackBodies.set(`/${cleanPath}`, new TextDecoder().decode(bytes));
            } else {
              devArtifactBodies.set(`${DEV_PACK_PREFIX}${cleanPath}`, {
                bytes,
                mimeType: mimeFromPath(cleanPath) ?? 'application/octet-stream',
              });
            }
          },
        },
        {
          base: '/',
          packagePath: packageUrl.replace(/^\/+/, ''),
          artifactPath: (guid, key) => `${guid}/${key}.bin`,
        },
      );
      published.set(entry.packageUrl, finalized.packageUrl);
      cookedRefs.set(entry.packageUrl, cooked.refsByGuid);
    }
    for (const [packageUrl, body] of bodies) metaPackBodies.set(packageUrl, body);
    return raw.map((entry) => {
      const packageUrl = published.get(entry.packageUrl);
      if (packageUrl === undefined) return entry;
      const refs = cookedRefs.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
      return refs === undefined
        ? { ...entry, packageUrl, ...DIRECT_CURRENT_PROJECTION }
        : { ...entry, packageUrl, ...AUTHORED_COOKED_CURRENT_PROJECTION, refs };
    });
  }

  // Import exactly ONE texture GUID to the DDC
  // (`node_modules/.cache/forgeax-ddc/<guid>.bin`, see ddcPath -- gitignored,
  // never written into the source tree) and incrementally patch the
  // live catalog + urlToAbs for that single row. No whole-catalog rebuild, no
  // global swap. Idempotent: a GUID already in the import overlay returns its
  // imported row without re-importing. Returns `[]` when the GUID is absent from
  // the catalog or its row is not an importable texture (the caller fails fast
  // rather than silently rebuilding).
  async function importOneTexture(guidLower: string): Promise<PackIndexEntry[]> {
    const already = importedRows.get(guidLower);
    if (already !== undefined) return [already];
    const raw = catalog.find((e) => e.guid.toLowerCase() === guidLower);
    if (raw === undefined) return [];
    const imported = await importTextureEntry(raw, {
      cwd: process.cwd(),
      metaPath: guidToMeta.get(guidLower),
    });
    if ('skipped' in imported) {
      // Fail-fast (architecture-principles §5), mirroring the per-meta path's
      // `throw runResult.error`: a REAL cook failure (source read / decode /
      // no-produced) must surface a structured ImportError so the POST route
      // reports `.code` + `detail.reason` in the 422 body and the browser
      // console -- not collapse to `[]` -> a generic "could not be imported".
      // A BENIGN skip (non-texture kind / unknown extension) is not an error:
      // return `[]` so the route 422s with the generic "not an importable
      // texture" hint (the build arm passes the raw row through; the dev route
      // has no raw-row fallback, so `[]` is the benign signal here).
      if (imported.real) {
        throw new ImportError({
          code: 'import-internal-error',
          expected: `an importable texture source for guid ${raw.guid}`,
          hint: IMPORT_ERROR_HINTS['import-internal-error'],
          detail: { reason: imported.skipped },
        });
      }
      return [];
    }
    const binAbs = ddcPath(process.cwd(), guidLower);
    await mkdir(dirname(binAbs), { recursive: true });
    // (A) Texture arm dev: compress after importTextureEntry, before writeFile (D-3).
    // M2 default 'none' → pass-through; M3 flips to 'zstd' in STRATEGY_TABLE.
    // AC-01: honor an explicit importSettings.compression override from the meta.
    const texOverride = await readOverrideFromMeta(guidToMeta.get(guidLower));
    const compressed = await compressArtifact({
      bytes: imported.bytes,
      kind: 'texture',
      isPackJson: false,
      ...(texOverride !== undefined ? { override: texOverride } : {}),
      // Carry the importer's resolved delivery encoding so a Basis KTX2 row
      // records its basis-* discriminant (loader transcode dispatch) instead of
      // the STRATEGY_TABLE 'none' default (which fell through to a scheme=1 KTX2
      // reject). Dev path parity with the build arm.
      ...(imported.metadata.compression !== undefined
        ? { alreadyCompressed: imported.metadata.compression }
        : {}),
    });
    await writeFile(binAbs, compressed.compressed);
    const packageUrl = `${DEV_PACK_PREFIX}${guidLower}.pack.json`;
    const artifactUrl = `${DEV_PACK_PREFIX}${guidLower}/body.bin`;
    const artifactCodec =
      compressed.compression === 'basis-etc1s'
        ? { name: 'basis', profile: 'etc1s' }
        : compressed.compression === 'basis-uastc'
          ? { name: 'basis', profile: 'uastc-ldr' }
          : compressed.compression === 'basis-uastc-hdr'
            ? { name: 'basis', profile: 'uastc-hdr' }
            : undefined;
    devArtifactBodies.set(artifactUrl, {
      bytes: compressed.compressed,
      mimeType: 'application/octet-stream',
    });
    metaPackBodies.set(
      packageUrl,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: raw.guid,
            kind: raw.kind,
            payload: {
              kind: raw.kind,
              width: imported.metadata.width ?? 0,
              height: imported.metadata.height ?? 0,
              format: imported.metadata.format,
              colorSpace: imported.metadata.colorSpace,
              mipmap: imported.metadata.mipmap,
            },
            refs: [],
            artifacts: {
              body: {
                path: `${guidLower}/body.bin`,
                mediaType: 'application/octet-stream',
                ...(artifactCodec === undefined ? {} : { assetCodec: artifactCodec }),
                ...(compressed.compression === 'zstd' ? { contentEncoding: 'zstd' } : {}),
                byteLength: imported.bytes.byteLength,
              },
            },
          },
        ],
      }),
    );
    const importedRow: PackIndexEntry = {
      guid: raw.guid,
      packageUrl,
      kind: raw.kind,
      // Preserve the ORIGINAL source path (the `.jpg`/`.png`/`.hdr`), matching
      // the build-mode `generateBundle` import which keeps `sourcePath:
      // entry.sourcePath` and only rewrites `packageUrl` to the imported `.bin`.
      // Consumers reverse-map a glTF texture URI to its GUID via
      // `sourcePath.endsWith(uri)` (e.g. learn-render 3.1 model-loading's
      // findTextureGuidByFilename); overwriting `sourcePath` with the `.bin`
      // path broke that lookup on a warm refresh -- the row was discoverable on
      // cold load (raw `.jpg` sourcePath) but invisible after the import
      // overwrote it, so every texture silently dropped on the second load. The
      // imported bytes live in the DDC (binAbs), keyed into urlToAbs below by the
      // `.bin` packageUrl.
      sourcePath: raw.sourcePath,
      // Preserve the producer-owned display name across the lazy-import
      // projection. The raw catalog already derives this from the authored
      // source (`sky.hdr` for a single-asset HDR); dropping it here makes the
      // runtime identity fall back to the generated DDC package filename.
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...COOKED_CURRENT_PROJECTION,
    };
    importedRows.set(guidLower, importedRow);
    const idx = catalog.findIndex((e) => e.guid.toLowerCase() === guidLower);
    if (idx >= 0) catalog[idx] = importedRow;
    return [importedRow];
  }

  // M4 / w20 (D-2): per-meta import. Called once per metaPath, runs the
  // import runner on the whole sidecar, writes imported .bin entries to the
  // DDC, overlays all produced rows onto the catalog, and returns the
  // resulting PackIndexEntry[] for all rows belonging to this meta.
  async function startMetaImport(metaPath: string): Promise<PackIndexEntry[]> {
    const cwd = process.cwd();
    const previousCatalog = [...catalog];
    const previousImportedRows = new Map(importedRows);
    const { paths } = loadAssetConfig(cwd);
    let rm: unknown;
    try {
      rm = JSON.parse(await readFile(metaPath, 'utf-8'));
    } catch {
      throw new ImportError({
        code: 'import-internal-error',
        expected: `parseable JSON meta sidecar at ${metaPath}`,
        hint: IMPORT_ERROR_HINTS['import-internal-error'],
        detail: { reason: `failed to read or parse meta sidecar: ${metaPath}` },
      });
    }
    const meta = rm as {
      importer: string;
      source?: string;
      importSettings?: unknown;
      sourceOverrides?: unknown;
      subAssets: ReadonlyArray<{ guid: string; sourceIndex: number; kind: string }>;
    };

    // AC-01: explicit per-asset compression override declared in importSettings.
    const metaOverride = readCompressionOverride(meta.importSettings);

    const sourceResult = resolveAssetSource(metaPath, meta.source, paths);
    if (!sourceResult.ok) {
      throw new ImportError({
        code: 'import-internal-error',
        expected: `resolvable source in meta sidecar at ${metaPath}`,
        hint: sourceResult.error.hint,
        detail: { reason: `source resolution failed: ${sourceResult.error.code}` },
      });
    }

    const runMeta: RunImportMeta = {
      importer: meta.importer,
      source: sourceResult.value,
      subAssets: meta.subAssets,
    };
    if (meta.importSettings !== undefined) {
      (runMeta as { importSettings?: Readonly<Record<string, unknown>> }).importSettings =
        meta.importSettings as Readonly<Record<string, unknown>>;
    }
    if (meta.sourceOverrides !== undefined) {
      (runMeta as { sourceOverrides?: unknown }).sourceOverrides = meta.sourceOverrides;
    }

    const runResult = await runImport(runMeta, importerRegistry, fsForImport);
    // Fail-fast (architecture-principles §5): a failed import must not collapse
    // to an empty result that the route can only report as a generic
    // `import-failed`. Throw the structured ImportError so the dev route can
    // surface `.code` + `detail.reason` (e.g. `fbx-mesh-type-unsupported` ->
    // "convert NURBS to polygon mesh") in the 422 body and the browser console, instead of the
    // opaque `asset-not-imported` the runtime otherwise reports.
    if (!runResult.ok) {
      for (const sub of meta.subAssets) {
        const diagnostics =
          runResult.error.code === 'source-validation-failed' &&
          'diagnostics' in runResult.error.detail
            ? runResult.error.detail.diagnostics.map((diagnostic) => ({
                sourcePath: diagnostic.sourcePath,
              }))
            : [];
        uiDependencies.recordFailure({
          guid: sub.guid,
          sourcePath: meta.source ?? sourceResult.value,
          diagnostics,
          revision: 0,
        });
      }
      throw runResult.error;
    }
    if ('skipped' in runResult.value) return [];

    const routeSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
    const finalizedUi =
      meta.importer === 'ui' && routeSubGuid !== undefined
        ? finalizeUiArtifact(runResult.value.product as never, {
            artifactUrl: (artifact) => `${DEV_PACK_PREFIX}${routeSubGuid}/${artifact.path}`,
          })
        : undefined;
    if (finalizedUi !== undefined && !finalizedUi.ok) {
      throw new ImportError({
        code: 'import-internal-error',
        expected: finalizedUi.error.expected,
        hint: finalizedUi.error.hint,
        detail: { reason: finalizedUi.error.detail.token ?? finalizedUi.error.code },
      });
    }
    const transportProduct =
      finalizedUi?.ok === true
        ? {
            ...runResult.value.product,
            assets: runResult.value.product.assets.map((asset, index) =>
              index === 0 ? { ...asset, payload: finalizedUi.value.asset } : asset,
            ),
          }
        : runResult.value.product;
    const logicalPackage = projectAssetProduction(transportProduct).logicalPackage;
    const finalizedRoute =
      routeSubGuid === undefined
        ? undefined
        : await packageRoutes.publish(
            { origin: 'sourceMeta', cooked: true, logicalPackage },
            {
              write: (path, bytes) => {
                const cleanPath = path.replace(/^\/+/, '');
                if (cleanPath.endsWith('.pack.json')) {
                  metaPackBodies.set(`/${cleanPath}`, new TextDecoder().decode(bytes));
                  return;
                }
                devArtifactBodies.set(`${DEV_PACK_PREFIX}${cleanPath}`, {
                  bytes,
                  mimeType: mimeFromPath(cleanPath) ?? 'application/octet-stream',
                });
              },
            },
            {
              base: '/',
              packagePath: `${DEV_PACK_PREFIX.replace(/^\/+/, '')}${routeSubGuid}.pack.json`,
              artifactPath: (guid, key) => `${guid}/${key}.bin`,
            },
          );
    if (finalizedRoute !== undefined && !finalizedRoute.ok) {
      throw new ImportError({
        code: 'import-internal-error',
        expected: finalizedRoute.error.expected,
        hint: finalizedRoute.error.hint,
        detail: { reason: finalizedRoute.error.code },
      });
    }
    const finalizedPack = finalizedRoute?.ok ? finalizedRoute.value.pack : undefined;

    if (meta.importer === 'ui') {
      const guid = meta.subAssets[0]?.guid;
      if (guid === undefined) return [];
      uiDependencies.recordSuccess(guid, runResult.value.product.sourceDependencies);
      const uiRow = catalog.find((entry) => entry.guid.toLowerCase() === guid.toLowerCase());
      if (uiRow !== undefined) {
        const packUrl = finalizedRoute?.ok
          ? finalizedRoute.value.packageUrl
          : `${DEV_PACK_PREFIX}${guid.toLowerCase()}.pack.json`;
        const updated = { ...uiRow, packageUrl: packUrl };
        importedRows.set(guid.toLowerCase(), updated);
        const index = catalog.findIndex((entry) => entry.guid.toLowerCase() === guid.toLowerCase());
        if (index >= 0) catalog[index] = updated;
        return [updated];
      }
      return [];
    }

    const pack = finalizedPack ?? runResult.value.pack;
    const bins = productBinaryArtifacts(runResult.value.product);
    const allEntries: PackIndexEntry[] = [];

    // bug-20260610-dev-meta-pack-not-served: serialise the produced pack JSON
    // ONCE and register it under a deterministic dev URL. Non-binary
    // sub-assets (mesh / scene / material) whose payloads live inside this
    // pack body get their `packageUrl` rewritten to point here, matching the
    // build-mode behaviour where every sub-asset row points at a hashed
    // `.pack.json` Rollup asset.
    const firstSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
    const packUrl =
      firstSubGuid !== undefined ? `${DEV_PACK_PREFIX}${firstSubGuid}.pack.json` : undefined;
    if (packUrl !== undefined) {
      metaPackBodies.set(packUrl, JSON.stringify(pack));
    }

    // For each sub-asset declared in the meta, look up its catalog row
    // and overlay the imported form.
    for (const sub of meta.subAssets) {
      const guidLower = sub.guid.toLowerCase();
      const raw = catalog.find((e) => e.guid.toLowerCase() === guidLower);
      if (raw === undefined) continue;

      // If this sub-asset has binary data in bins, write it to the DDC
      // and rewrite the row to a .bin packageUrl.
      const bytes = bins?.get(guidLower);
      if (bytes !== undefined) {
        const binAbs = ddcPath(cwd, guidLower);
        await mkdir(dirname(binAbs), { recursive: true });
        // (C) Mesh bins arm dev: compress after bins.get, before writeFile (D-3).
        const compressKind = raw.kind === 'mesh' ? 'mesh' : 'texture';
        const compressedBin = await compressArtifact({
          bytes,
          kind: compressKind,
          isPackJson: false,
          ...(metaOverride !== undefined ? { override: metaOverride } : {}),
        });
        await writeFile(binAbs, compressedBin.compressed);
        // round-2 finding 4: overlay metadata.colorSpace / format / mipmap
        // from the imported TextureAsset payload so dev pack-index reflects
        // per-image truth (catalog default 'linear' is wrong for srgb
        // baseColors). Mirrors the generateBundle build-mode arm.
        const importedAsset = productAssetByGuid(runResult.value.product, guidLower);
        const importedRow: PackIndexEntry = {
          ...raw,
          guid: raw.guid,
          packageUrl: packUrl ?? raw.packageUrl,
          kind: raw.kind,
          sourcePath: raw.sourcePath,
          ...COOKED_CURRENT_PROJECTION,
          // Carry the raw catalog row's derived display name (buildCatalog ->
          // deriveAssetName: source basename for GLB sub-assets) into the
          // imported row. Rebuilding the row field-by-field dropped it, so a
          // lazy-cooked GLB's sub-assets showed blank in the Content Browser
          // while the un-cooked /pack-index.json still had the name.
          ...(raw.name !== undefined ? { name: raw.name } : {}),
          // Carry the DDC's outgoing dependency edges into the catalog row so
          // the Content Browser dependency graph sees them without re-fetching
          // the .pack.json body (feat: listCatalog refs).
          ...(importedAsset?.refs !== undefined
            ? { refs: importedAsset.refs.map((ref) => ref.guid) }
            : {}),
        };
        importedRows.set(guidLower, importedRow);
        const idx = catalog.findIndex((e) => e.guid.toLowerCase() === guidLower);
        if (idx >= 0) catalog[idx] = importedRow;
        urlToAbs.set(importedRow.packageUrl, binAbs);
        allEntries.push(importedRow);
      } else {
        // Non-binary sub-assets (mesh / material / scene): the payload lives
        // inside the in-memory pack body. Point `packageUrl` at the dev pack
        // URL so the runtime's `fetchPackFile` reaches a body containing
        // `assets[]` (mirroring the build-mode hashed `.pack.json` rewrite at
        // generateBundle:~1000-1024). Keeping `raw` here was the
        // bug-20260610 root cause — runtime fetched the raw `.gltf` JSON,
        // found no `assets[]`, returned `asset-not-found`.
        // Carry the DDC's outgoing dependency edges (e.g. material -> texture,
        // scene -> mesh) into the catalog row so the Content Browser dependency
        // graph sees them without re-fetching the .pack.json body.
        const nonBinAsset = productAssetByGuid(runResult.value.product, guidLower);
        const importedRow: PackIndexEntry =
          packUrl !== undefined
            ? {
                ...raw,
                guid: raw.guid,
                packageUrl: packUrl,
                kind: raw.kind,
                sourcePath: raw.sourcePath,
                ...COOKED_CURRENT_PROJECTION,
                // Same as the binary arm: preserve the derived display name the
                // field-by-field rebuild would otherwise drop.
                ...(raw.name !== undefined ? { name: raw.name } : {}),
                ...(nonBinAsset?.refs !== undefined
                  ? { refs: nonBinAsset.refs.map((ref) => ref.guid) }
                  : {}),
              }
            : nonBinAsset?.refs !== undefined
              ? { ...raw, refs: nonBinAsset.refs.map((ref) => ref.guid) }
              : raw;
        importedRows.set(guidLower, importedRow);
        const idx = catalog.findIndex((e) => e.guid.toLowerCase() === guidLower);
        if (idx >= 0) catalog[idx] = importedRow;
        allEntries.push(importedRow);
      }
    }

    if ('pack' in runResult.value) {
      // Best-effort: persist the pack JSON to the on-disk DDC so a future
      // build-mode pre-import (or out-of-process tool) can see it. The dev
      // request path itself reads from the in-memory `metaPackBodies` map
      // (set above), not from this file, so a write failure here is
      // diagnostic-only and does not block the import.
      const packJson = metaPackBodies.get(packUrl ?? '');
      if (packUrl !== undefined && packJson !== undefined && firstSubGuid !== undefined) {
        try {
          const packPath = ddcPath(cwd, `${firstSubGuid}.meta.pack`);
          await mkdir(dirname(packPath), { recursive: true });
          await writeFile(packPath, packJson);
        } catch (e) {
          console.warn('[forgeax-pack] persist DDC pack failed:', e);
        }
      }
    }

    if (firstSubGuid !== undefined && 'pack' in runResult.value) {
      const desiredKey = semanticDdcKey({
        schemaVersion: '2.0.0',
        importerVersion: meta.importer,
        codecVersion: 'pack-v2',
        sourceDependencies: runResult.value.product.sourceDependencies,
        settings: meta.importSettings ?? {},
        declaredGuids: meta.subAssets.map((sub) => sub.guid),
        cookProfile: 'dev',
        ...(meta.sourceOverrides === undefined ? {} : { sourceOverrides: meta.sourceOverrides }),
      });
      const publication = await publishImportPublication({
        root: resolveDdcRoot(cwd),
        guid: firstSubGuid,
        desiredKey,
        pack,
        previousCatalog,
        nextCatalog: catalog,
        publishedGuids: allEntries.map((entry) => entry.guid),
        onDelta: (delta) => publishCatalogDelta?.(delta),
      });
      if (!publication.ok) {
        catalog = previousCatalog;
        importedRows.clear();
        for (const [guid, row] of previousImportedRows) importedRows.set(guid, row);
        if (packUrl !== undefined) metaPackBodies.delete(packUrl);
        throw new ImportError({
          code: 'import-internal-error',
          expected: publication.error.expected,
          hint: publication.error.hint,
          detail: { reason: publication.error.detail },
        });
      }
      catalog = [...publication.catalog];
      catalogProjection = { ...catalogProjection, entries: catalog };
      const publishedRows = new Map(
        publication.catalog.map((entry) => [entry.guid.toLowerCase(), entry]),
      );
      for (let index = 0; index < allEntries.length; index += 1) {
        const current = allEntries[index];
        if (current === undefined) continue;
        const projected = publishedRows.get(current.guid.toLowerCase());
        if (projected !== undefined) allEntries[index] = projected;
      }
      for (const entry of allEntries) importedRows.set(entry.guid.toLowerCase(), entry);
    }

    return allEntries;
  }

  /**
   * Resolve a first-read Pack v2 URL without leaking a normal lazy-import
   * miss as a browser-visible 404. Catalog rows for external sources point at
   * their eventual cooked package from the outset; the first GET therefore
   * owns the same coalesced cook as POST /__import/:guid and serves the body
   * once it exists.
   */
  async function ensureMetaPackBody(url: string): Promise<string | undefined> {
    const existing = metaPackBodies.get(url);
    if (existing !== undefined) return existing;
    if (!url.startsWith(DEV_PACK_PREFIX) || !url.endsWith('.pack.json')) return undefined;

    const guid = url.slice(DEV_PACK_PREFIX.length, -'.pack.json'.length).toLowerCase();
    if (guid.includes('/')) return undefined;
    const metaPath = guidToMeta.get(guid);
    if (metaPath === undefined) return undefined;

    let inflight = inFlightMetaImports.get(metaPath);
    if (inflight === undefined) {
      inflight = startMetaImport(metaPath).finally(() => inFlightMetaImports.delete(metaPath));
      inFlightMetaImports.set(metaPath, inflight);
    }
    await inflight;
    return metaPackBodies.get(url);
  }

  // M4 / w32 (AC-20): build the ImporterRegistry from the plugin options
  // at init time so the HTTP route has importers to dispatch to.
  const importerRegistry = new ImporterRegistry();
  const importers = opts.importers ?? [];
  for (const imp of importers) {
    importerRegistry.register(imp);
  }
  // UiAsset author sources are a first-party pack product. Register the
  // importer at the plugin boundary so every dev/build transport path shares
  // the same registry even when an app only declares pluginPack({ roots }).
  // Explicit host wiring may still replace it by key for tests or extensions.
  if (importerRegistry.get('ui') === undefined) {
    importerRegistry.register({ key: 'ui', ...createUiImporter() });
  }
  // P2 (feat-20260629 D-3): the host importer key set the catalog fold layer
  // uses to drive default passthrough vs raw-source rows. Engine built-in arms
  // fold unconditionally and are NOT part of this set.
  const registeredImporterKeys: ReadonlySet<string> = new Set(
    importerRegistry.registeredImporters(),
  );

  // M4 / w32 (AC-20) + feat-20260608 round-2: create the filesystem adapter
  // for the import runner. `decodeImage` and `readSibling` are wired here so
  // the gltfImporter's three image-source paths (bufferView / data: URI /
  // external URI sibling read) actually produce textures at build time --
  // without these the runner returns `import-internal-error` (the runner's
  // default `decodeImage` throws), the build silently falls through the `!ok`
  // branch (line ~898), and gltf scene/mesh/material rows never get their
  // hashed `.pack.json` overlay (production runtime then reads the source
  // .gltf as JSON, finds no `assets[]`, and loadByGuid<SceneAsset> fails
  // with `asset-not-found`). Engine fix per AGENTS.md "Demo failures route
  // to engine fixes, not workarounds": the demo's loadByGuid path does not
  // work without this wiring.
  const fsForImport: ImportRunnerFs = {
    async readSource(sourcePath: string) {
      try {
        const buf = await readFile(sourcePath);
        return { ok: true, value: new Uint8Array(buf) };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    async readSibling(sourcePath: string, uri: string) {
      try {
        const dir = dirname(sourcePath);
        const buf = await readFile(resolve(dir, uri));
        return { ok: true, value: new Uint8Array(buf) };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    async decodeImage(bytes, mimeType, importSettings) {
      // Lazy-import the Node-only image decoder and Basis encoder so the build
      // path stays browser-safe at module load time. The same callback serves
      // glTF bufferView/data-URI/external images; keeping the encode here means
      // embedded images and standalone image sidecars share one delivery seam.
      const { parseImage } = await import('@forgeax/engine-image/parse-image');
      const { encodeTextureToKtx2, resolveEncodeMode } = await import(
        '@forgeax/engine-image/ktx2-encode'
      );
      const colorSpace =
        importSettings.colorSpace === 'srgb' || importSettings.colorSpace === 'linear'
          ? importSettings.colorSpace
          : 'linear';
      const mipmap = importSettings.mipmap === true;
      const downscaleMaxDimension =
        typeof importSettings.downscaleMaxDimension === 'number' &&
        Number.isInteger(importSettings.downscaleMaxDimension) &&
        importSettings.downscaleMaxDimension > 0
          ? importSettings.downscaleMaxDimension
          : undefined;
      const decoded = parseImage(bytes, mimeType, {
        colorSpace,
        mipmap,
        ...(downscaleMaxDimension !== undefined ? { downscaleMaxDimension } : {}),
      });
      if (!decoded.ok) return decoded;
      const tex = decoded.value;
      // bug-20260610: format MUST agree with colorSpace (sRGB textures need
      // the `-srgb` GPU format suffix so the sampling hardware decodes the
      // perceptual gamma curve). A hardcoded `rgba8unorm` produced a
      // (format=linear, colorSpace=srgb) mismatch -- the runtime
      // prepareTextureUpload then either rejected the upload (image-format-
      // unsupported) or sampled the texture without sRGB decoding, which
      // washed every albedo to a uniform mid-grey on Sponza (#332 follow-up).
      const format = colorSpace === 'srgb' ? ('rgba8unorm-srgb' as const) : ('rgba8unorm' as const);
      const requestedCompression =
        importSettings.compressionMode === 'auto' ||
        importSettings.compressionMode === 'etc1s' ||
        importSettings.compressionMode === 'uastc' ||
        importSettings.compressionMode === 'none'
          ? importSettings.compressionMode
          : 'none';
      const resolvedCompression = resolveEncodeMode(requestedCompression, {
        colorSpace,
        isHdr: false,
      });
      let cookedBytes = tex.bytes;
      let mediaType: string = mimeType;
      let assetCodec: { name: string; profile?: string; version?: string } = {
        name: 'rgba8',
        version: '1',
      };
      if (resolvedCompression !== 'none') {
        const encoded = await encodeTextureToKtx2(
          tex.bytes,
          tex.width,
          tex.height,
          requestedCompression,
          { colorSpace, isHdr: false },
        );
        if (!encoded.ok) {
          throw new Error(
            `gltf embedded texture compression failed (${encoded.error.code} / ${encoded.error.mode}): ${encoded.error.reason}`,
          );
        }
        cookedBytes = encoded.value.ktx2;
        mediaType = 'image/ktx2';
        assetCodec = { name: 'basis', profile: encoded.value.mode };
      }
      return {
        ok: true,
        value: {
          texture: {
            kind: 'texture' as const,
            data: cookedBytes,
            width: tex.width,
            height: tex.height,
            format,
            colorSpace,
            mipmap,
          },
          bytes: cookedBytes,
          mediaType,
          assetCodec,
        },
      };
    },
  };

  // ─── configureServer (dev mode) ──────────────────────────────────────────

  function configureServer(server: ViteDevServerLike): void {
    publishCatalogDelta = (delta) => {
      server.ws?.send({ type: 'custom', event: CATALOG_DELTA_EVENT, data: delta });
    };
    // Async startup: scan roots to build the initial catalog.
    const { roots } = resolvePackBuildInputs(opts);
    // Install the watcher before the async initial scan. A host can edit an
    // asset as soon as the dev server exists; delaying watch registration until
    // the scan resolves loses that first mutation (and its refresh signal).
    let resolveStartupReady!: () => void;
    const startupReady = new Promise<void>((resolve) => {
      resolveStartupReady = resolve;
    });
    let applyWatchBatch: ((batch: WatchBatch) => Promise<void>) | undefined;
    let serialBatches = Promise.resolve();
    watchDevRoots({
      roots,
      onBatch: (batch) => {
        serialBatches = serialBatches.then(async () => {
          await startupReady;
          await applyWatchBatch?.(batch);
        });
        return serialBatches;
      },
    });
    Promise.all([
      buildCatalogProjection(roots, opts.base, registeredImporterKeys),
      buildGuidToMetaMap(roots),
    ])
      .then(async ([rawProjection, g2m]) => {
        // The dev catalog passes the discoverable bare-source texture rows
        // straight through, with the per-asset import overlay applied so any
        // already-imported `.bin` row survives the rebuild (monotonic import).
        // The runtime loader (import-on-demand sentinel) routes any non-`.bin`
        // texture row to the dev transport for lazy import; keeping the row
        // discoverable is the precondition for Sponza's catalog-first
        // findTextureGuidByFilename.
        installCatalogProjection({
          ...rawProjection,
          entries: await publishAuthoredDevPacks(rawProjection.entries),
        });
        guidToMeta = g2m;
        urlToAbs = buildUrlToAbsolute(catalog, {
          cwd: process.cwd(),
          ddcPath: (guid) => ddcPath(process.cwd(), guid),
        });
        catalogReady = true;

        applyWatchBatch = async ({ sidecars, sources }) => {
          let catalogChanged = false;
          // A source edit invalidates the dev DDC overlay for rows whose
          // declaring source changed. Without this, the full-reload signal
          // reaches the browser but POST /__import returns the stale
          // imported row from `importedRows` before the importer runs again.
          // Resolve both watcher-relative filenames and catalog-relative
          // source paths against their owning roots/cwd so this remains
          // correct for roots outside the Vite project directory.
          const changedSourcePaths = new Set<string>();
          for (const info of sources) {
            changedSourcePaths.add(resolve(info.filename));
            for (const root of roots) changedSourcePaths.add(resolve(root, info.filename));
          }
          const invalidatedPackUrls = new Set<string>();
          const invalidatedGuids = new Set<string>();
          for (const [guid, row] of importedRows) {
            if (!changedSourcePaths.has(resolve(process.cwd(), row.sourcePath))) continue;
            invalidatedPackUrls.add(row.packageUrl);
            invalidatedGuids.add(guid);
            importedRows.delete(guid);
          }
          for (const packageUrl of invalidatedPackUrls) metaPackBodies.delete(packageUrl);
          const importedRowsInvalidated = invalidatedPackUrls.size > 0;

          // Rebuild on every source event, even after the failed import has
          // already removed importedRows. The recovery upload still needs to
          // carry the previous Catalog LKG into the fresh missing row.
          if (sidecars.length > 0 || sources.length > 0 || importedRowsInvalidated) {
            const previousCatalog = catalog;
            try {
              const [rawProjection2, g2m2] = await Promise.all([
                buildCatalogProjection(roots, opts.base, registeredImporterKeys),
                buildGuidToMetaMap(roots),
              ]);
              installCatalogProjection({
                ...rawProjection2,
                entries: preserveInvalidatedCatalogLkg(
                  previousCatalog,
                  await publishAuthoredDevPacks(rawProjection2.entries),
                  invalidatedGuids,
                ),
              });
              guidToMeta = g2m2;
              urlToAbs = buildUrlToAbsolute(catalog, {
                cwd: process.cwd(),
                ddcPath: (guid) => ddcPath(process.cwd(), guid),
              });
              const delta = calculateCatalogDelta(previousCatalog, catalog);
              if (delta !== undefined) {
                catalogChanged = true;
                server.ws?.send({ type: 'custom', event: CATALOG_DELTA_EVENT, data: delta });
              }
            } catch (err: unknown) {
              console.warn('[forgeax-pack] rebuild catalog error:', err);
            }
          }
          if (opts.refresh !== undefined) opts.refresh(server);
          else {
            const hasCatalogSidecar = sidecars.some(
              (info) =>
                info.filename.endsWith('.meta.json') || info.filename.endsWith('.pack.json'),
            );
            if (!catalogChanged && !hasCatalogSidecar) server.ws?.send({ type: 'full-reload' });
          }
          const revision = Date.now();
          for (const info of sidecars) {
            emitAssetChanged(server, info.filename, info.eventType, 'sidecar');
            const event = createAssetChangedEvent({
              file: info.filename,
              event: info.eventType,
              kind: 'sidecar',
              sourcePath: info.filename,
              revision,
              guids: uiDependencies.guidsForSource(info.filename),
            });
            if (event !== undefined) server.ws?.send(event);
          }
          for (const info of sources) {
            emitAssetChanged(server, info.filename, info.eventType, 'source');
            const event = createAssetChangedEvent({
              file: info.filename,
              event: info.eventType,
              kind: 'source',
              sourcePath: info.filename,
              revision,
              guids: uiDependencies.guidsForSource(info.filename),
            });
            if (event !== undefined) server.ws?.send(event);
          }
          const parts: string[] = [];
          if (sidecars.length > 0) parts.push(`${sidecars.length} sidecar`);
          if (sources.length > 0) parts.push(`${sources.length} source`);
          console.warn(`[forgeax-pack] assets changed: ${parts.join(', ')} (reloaded)`);
        };
        resolveStartupReady();
      })
      .catch((err: unknown) => {
        console.warn('[forgeax-pack] startup scan error:', err);
        catalogReady = true;
        resolveStartupReady();
      });

    // Register connect middleware for /__pack/* routes + the
    // dev-mode `/pack-index.json` route (charter P4 consistent
    // abstraction: production emits the same file via generateBundle).
    server.middlewares.use(async (req, res, next) => {
      const url = req.url ?? '';

      if (url === '/__pack/index' || url === '/pack-index.json') {
        // Wait for catalog to be ready (short-circuit if already built).
        if (!catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (catalogReady) {
                clearInterval(interval);
                resolve();
              }
            }, 5);
          });
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(legacyCatalogResponse()));
        return;
      }

      const lookupPrefix = '/__pack/lookup/';
      if (url.startsWith(lookupPrefix)) {
        if (!catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (catalogReady) {
                clearInterval(interval);
                resolve();
              }
            }, 5);
          });
        }
        const guid = url.slice(lookupPrefix.length);
        const entry = catalog.find((e) => e.guid.toLowerCase() === guid.toLowerCase());
        if (entry === undefined) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'not-found', guid }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(entry));
        return;
      }

      // M4 / w32 (AC-20): POST /__import/:guid — lazy import adapter.
      // The dev form of ImportTransport calls this endpoint when a DDC is
      // missing. The route reads the declaring meta sidecar, dispatches the
      // importer via the import runner, writes the DDC (.pack.json) to the
      // source directory, upgrades the catalog, and returns the updated
      // PackIndexEntry[] for the imported GUID + its sub-assets.
      const importPrefix = '/__import/';
      if (url.startsWith(importPrefix)) {
        // Only POST triggers import; GET returns 405 so AI users get a
        // clear signal.
        if ((req as { method?: string }).method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Allow', 'POST');
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'method-not-allowed',
              hint: 'use POST to trigger lazy import',
            }),
          );
          return;
        }
        if (!catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (catalogReady) {
                clearInterval(interval);
                resolve();
              }
            }, 5);
          });
        }
        const guid = url.slice(importPrefix.length);
        const guidLower = guid.toLowerCase();

        // Precise 404: the GUID is declared by no sidecar at all (vs. declared
        // but not an importable texture, which falls through to a 422 below).
        if (guidToMeta.get(guidLower) === undefined && importedRows.get(guidLower) === undefined) {
          // A sidecar can be written immediately before this request, before
          // the debounced watcher flushes its catalog/index update. Refresh
          // the lightweight GUID index once so the import endpoint remains
          // race-free for just-written authoring sources.
          guidToMeta = await buildGuidToMetaMap(roots);
          const refreshedProjection = await buildCatalogProjection(
            roots,
            opts.base,
            registeredImporterKeys,
          );
          installCatalogProjection({
            ...refreshedProjection,
            entries: await publishAuthoredDevPacks(refreshedProjection.entries),
          });
          urlToAbs = buildUrlToAbsolute(catalog, {
            cwd: process.cwd(),
            ddcPath: (guid) => ddcPath(process.cwd(), guid),
          });
        }
        if (guidToMeta.get(guidLower) === undefined && importedRows.get(guidLower) === undefined) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'meta-not-found',
              guid,
              hint: 'no sidecar declares this GUID',
            }),
          );
          return;
        }

        // M4 / w20 (D-2): per-meta import coalescing. When this GUID belongs
        // to a gltf sidecar (whose import produces multiple sub-assets per
        // meta), we import the WHOLE meta once and overlay all rows at once.
        // Concurrent requests for the same metaPath share the same in-flight
        // Promise via inFlightMetaImports. The per-asset path below
        // (importOneTexture + inFlightImports) handles image sidecars where a
        // single GUID maps to a single texture asset.
        //
        // Dispatch: if the GUID belongs to an already-imported row (per-asset
        // path), return it immediately. Otherwise route through per-meta for
        // gltf sidecars, per-asset for everything else.
        const alreadyImported = importedRows.get(guidLower);
        if (alreadyImported !== undefined) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify([alreadyImported]));
          return;
        }

        const metaPath = guidToMeta.get(guidLower);
        let resultEntries: PackIndexEntry[];

        // Route registered non-image importers through the per-meta runner.
        // gltf / fbx / ui are engine products with explicit multi-asset
        // handling, while a registered host importer has the same contract:
        // one source + meta sidecar produces a DDC pack that cannot be
        // reconstructed by the texture-only path. The registry is the SSOT
        // for whether a host importer is wired; an unregistered key still
        // falls through to the raw-source catalog behavior. `image` remains
        // on the per-asset path because its texture importer has a dedicated
        // binary delivery arm and must not be re-run through a pack body.
        // fbx behaves like gltf — a single .fbx source file produces multiple
        // sub-asset rows (mesh / material / scene / texture / skeleton / skin /
        // animation-clip) that need to be imported together via runImport
        // (feat-20260615-fbx-importer-via-sdk).
        let isMultiAssetMeta = false;
        if (metaPath !== undefined) {
          try {
            const metaRaw = JSON.parse(await readFile(metaPath, 'utf-8')) as {
              importer?: string;
            };
            // UI author sources are products with companion artifacts. They
            // must use the per-meta importer path so startMetaImport can
            // finalize HTML/CSS and publish the in-memory /__ui payloads;
            // treating them as textures returns an empty result (422).
            isMultiAssetMeta =
              metaRaw.importer === 'gltf' ||
              metaRaw.importer === 'fbx' ||
              metaRaw.importer === 'ui' ||
              (metaRaw.importer !== 'image' &&
                metaRaw.importer !== undefined &&
                importerRegistry.get(metaRaw.importer) !== undefined);
          } catch {
            // Unreadable meta — fall through to per-asset.
          }
        }

        // Both arms throw the structured ImportError on a REAL failure
        // (fail-fast): per-meta via `startMetaImport`'s `throw runResult.error`,
        // per-asset via `importOneTexture`'s `throw new ImportError`. One shared
        // catch preserves `.code` + `.detail` so AI/human users can consume
        // the original structured failure (including source-validation
        // diagnostics) instead of a generic `import-failed`.
        try {
          if (metaPath !== undefined && isMultiAssetMeta) {
            // Per-meta path: coalesce on metaPath.
            let inflightMeta = inFlightMetaImports.get(metaPath);
            if (inflightMeta === undefined) {
              inflightMeta = startMetaImport(metaPath).finally(() =>
                inFlightMetaImports.delete(metaPath),
              );
              inFlightMetaImports.set(metaPath, inflightMeta);
            }
            resultEntries = await inflightMeta;
            // Filter to the requested GUID's row.
            const requested = resultEntries.find((e) => e.guid.toLowerCase() === guidLower);
            resultEntries = requested !== undefined ? [requested] : [];
          } else {
            // Fallback per-asset path (image sidecars, single-texture import).
            let inflight = inFlightImports.get(guidLower);
            if (inflight === undefined) {
              inflight = importOneTexture(guidLower).finally(() =>
                inFlightImports.delete(guidLower),
              );
              inFlightImports.set(guidLower, inflight);
            }
            resultEntries = await inflight;
          }
        } catch (e) {
          const err = e as {
            code?: string;
            hint?: string;
            detail?: unknown;
          };
          res.statusCode = 422;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'import-failed',
              guid,
              code: err.code ?? 'import-internal-error',
              detail: err.detail ?? { reason: e instanceof Error ? e.message : String(e) },
              hint: err.hint ?? 'importer threw while converting the source',
            }),
          );
          return;
        }

        if (resultEntries.length === 0) {
          // Benign empty result: the GUID is declared but not an importable
          // texture (non-texture kind / unknown extension -- `importOneTexture`
          // returns `[]` for these), or the per-meta filter found no matching
          // row. Real cook failures throw above and never reach here.
          res.statusCode = 422;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'import-failed',
              guid,
              hint: 'GUID declared but not an importable texture (non-texture kind, unknown extension, or no matching sub-asset row)',
            }),
          );
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(resultEntries));
        return;
      }

      // bug-20260610: serve in-memory `.pack.json` bodies produced by
      // `startMetaImport` for non-binary gltf sub-assets (mesh / scene /
      // material). The runtime's `fetchPackFile` GETs the catalog row's
      // `packageUrl`; without this route the request would fall through to
      // Vite's default 404 (or, worse, hit the raw `.gltf` URL when the row
      // was not rewritten and serve gltf JSON, which has no `assets[]`).
      const artifactBody = devArtifactBodies.get(url);
      if (artifactBody !== undefined) {
        res.statusCode = 200;
        res.setHeader('Content-Type', artifactBody.mimeType);
        res.end(artifactBody.bytes);
        return;
      }

      if (url.startsWith(DEV_PACK_PREFIX)) {
        let body: string | undefined;
        try {
          body = await ensureMetaPackBody(url);
        } catch (error) {
          res.statusCode = 422;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'pack-cook-failed',
              url,
              hint: error instanceof Error ? error.message : String(error),
            }),
          );
          return;
        }
        if (body === undefined) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'pack-body-not-found',
              url,
              hint: 'no startMetaImport has produced this pack URL yet',
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
        return;
      }

      // Serve external assets (e.g. submodule textures) that Vite
      // cannot find under the app root.  The catalog's `packageUrl`
      // paths are normalized (no `..` segments); the `urlToAbs` map
      // resolves each URL to its absolute source path.
      const absPath = urlToAbs.get(url);
      if (absPath !== undefined) {
        try {
          const buf = await readFile(absPath);
          const mime = mimeFromPath(absPath);
          if (mime !== undefined) {
            res.setHeader('Content-Type', mime);
          }
          res.statusCode = 200;
          res.end(buf);
          return;
        } catch {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
      }

      next();
    });
  }

  // ─── generateBundle (build mode) ─────────────────────────────────────────

  async function generateBundle(this: MinimalPluginContext): Promise<void> {
    const cwd = process.cwd();
    const { roots, basePrefix } = resolvePackBuildInputs(opts);
    const sharedManifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    if (sharedManifest !== undefined) {
      const shared = loadSharedPackInput(sharedManifest);
      if (
        shared.catalog !== undefined &&
        process.env.FORGEAX_SHARED_APP_INPUTS_MODE !== 'catalog-only'
      ) {
        if (shared.payloadRoot === undefined) {
          throw new Error(`shared pack manifest lacks payload for full mode: ${sharedManifest}`);
        }
        const emitted = new Set<string>();
        for (const entry of shared.catalog) {
          const outputPath = entry.packageUrl.replace(/^\/+/, '');
          if (emitted.has(outputPath)) continue;
          emitted.add(outputPath);
          this.emitFile({
            type: 'asset',
            fileName: outputPath,
            source: readFileSync(resolve(shared.payloadRoot, outputPath)),
          });
        }
      }
      if (shared.catalog !== undefined) {
        this.emitFile({
          type: 'asset',
          fileName: 'pack-index.json',
          source: JSON.stringify(projectSharedPackCatalog(shared.catalog, opts.base)),
        });
        return;
      }
      // A shader-only shared producer deliberately has no asset capability.
      // Fall through to the app's own roots so pack remains the sole owner of
      // its catalog, URL projection, and deployment payload.
    }
    const { paths } = loadAssetConfig(cwd);
    const projection = await buildCatalogProjection(roots, opts.base, registeredImporterKeys);
    if (projection.authority !== 'authoritative') {
      throw new Error(
        JSON.stringify({
          code: 'catalog-degraded',
          authority: projection.authority,
          diagnostics: projection.diagnostics,
        }),
      );
    }
    const entries = [...projection.entries];

    if (process.env.FORGEAX_SHARED_APP_INPUTS_MODE === 'catalog-only') {
      // Catalog probes validate metadata and browser/HMR wiring; the producer job owns full payload import.
      const catalog = projectSharedPackCatalog(entries, opts.base).map((entry) =>
        entry.packageUrl.startsWith('/assets/')
          ? entry
          : {
              ...entry,
              packageUrl: projectPackIndexUrl(basePrefix, `assets/${entry.guid.toLowerCase()}.bin`),
            },
      );
      this.emitFile({
        type: 'asset',
        fileName: 'pack-index.json',
        source: JSON.stringify(catalog),
      });
      return;
    }

    // Import step (M3 / w28, AC-21): the image import no longer inlines
    // `parseImage` here. It routes through the build-time `imageImporter`
    // (@forgeax/engine-image) -- the same Importer the @forgeax/engine-import
    // runner dispatches `meta.importer === 'image'` to (D-9: the image import
    // SSOT lives in engine-image). For each `kind: 'texture'` row we build a
    // one-subAsset `ImportContext` and call `imageImporter.import(ctx)`; the
    // returned `TextureAsset` payload carries the imported RGBA bytes (`data`)
    // plus `width` / `height`, which we extract into a hashed `.bin`
    // (D-1: untouched bytes; D-2: `name: '<guid-lowercase>'` + Rollup default
    // `assetFileNames` => `assets/<guid>-<hash>.bin`). The returned
    // `referenceId` bridges the GUID namespace to Rollup's hash namespace;
    // `getFileName(refId)` resolves the final hashed filename after emit.
    //
    // Pack-index entries are mutated in place (`packageUrl` -> hashed `.bin`;
    // `metadata.width / height` from the imported image). Non-image rows
    // (`mesh` / `scene` / `material`) flow through untouched. .hdr rows
    // (D-2: .hdr extension -> imageImporter HDR arm) are imported here;
    // other unknown extensions (no standard mime / no .hdr discriminant)
    // are passed through with the raw packageUrl so the catalog is not
    // silently dropped.
    // AC-01: guid -> meta path so the texture arm can honor an explicit
    // importSettings.compression override (built once, reused by the mesh arm
    // below as allGuidToMeta).
    const guidToMetaBuild = await buildGuidToMetaMap(roots);
    const authoredPackUrls = new Map<string, string>();
    const authoredPackUrlsBySource = new Map<string, string>();
    const authoredCookedRefs = new Map<string, ReadonlyMap<string, readonly string[]>>();
    for (const entry of entries) {
      if (
        !entry.packageUrl.endsWith('.pack.json') ||
        entry.packageUrl.includes('/__forgeax-ddc/') ||
        authoredPackUrls.has(entry.packageUrl)
      ) {
        continue;
      }
      const sourcePath = resolve(cwd, entry.sourcePath);
      const source = readFileSync(sourcePath, 'utf-8');
      const parsed = upgradeLegacyAuthoredPack(JSON.parse(source) as AuthoredPackInput);
      if (parsed.schemaVersion !== '2.0.0') continue;
      const cooked = await readCookedAuthoredPack(sourcePath);
      if (cooked !== undefined) {
        const firstGuid = entry.guid.toLowerCase();
        const finalized = await finalizePackage(
          cooked.logicalPackage,
          { write: () => {} },
          {
            base: basePrefix === '' ? '/' : basePrefix,
            packagePath: `assets/${firstGuid}.pack.json`,
            artifactPath: (guid, key) => `${guid}/${key}.bin`,
          },
        );
        for (const artifact of finalized.artifacts) {
          await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
        }
        const packRef = this.emitFile({
          type: 'asset',
          name: `${firstGuid}.pack.json`,
          originalFileName: sourcePath,
          source: JSON.stringify(finalized.pack),
        });
        const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
        authoredPackUrls.set(entry.packageUrl, packUrl);
        authoredPackUrlsBySource.set(entry.sourcePath, packUrl);
        authoredCookedRefs.set(entry.packageUrl, cooked.refsByGuid);
        continue;
      }
      const packRef = this.emitFile({
        type: 'asset',
        name: `${entry.guid.toLowerCase()}.pack.json`,
        originalFileName: sourcePath,
        source: JSON.stringify(parsed),
      });
      const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
      authoredPackUrls.set(entry.packageUrl, packUrl);
      authoredPackUrlsBySource.set(entry.sourcePath, packUrl);
    }
    const importedEntries: PackIndexEntry[] = [];
    for (const entry of entries) {
      // gap-3 (w5): the pure import logic now lives in the shared
      // `importTextureEntry` SSOT (import-texture.ts), used by both this build
      // arm and the dev POST /__import path (D-1). The shared fn returns
      // `{ skipped }` for any row that is not an importable image / .hdr
      // (non-texture kind, missing metadata, unknown extension, importer
      // throw, or absent produced asset) -- pass those through unchanged.
      const imported = await importTextureEntry(entry, {
        cwd,
        metaPath: guidToMetaBuild.get(entry.guid.toLowerCase()),
      });
      if ('skipped' in imported) {
        // Surface real import failures as a warning; silent pass-through for
        // benign non-importable rows (non-texture / unknown extension). The
        // benign-vs-real classification is the shared fn's `real` flag (one
        // SSOT), no longer a `skipped` string-prefix match here.
        if (imported.real) {
          console.warn(`[forgeax-pack] ${imported.skipped}`);
        }
        const packageUrl = authoredPackUrls.get(entry.packageUrl);
        const cookedRefs = authoredCookedRefs.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
        importedEntries.push(
          packageUrl === undefined
            ? entry
            : {
                ...entry,
                packageUrl,
                ...(entry.sourcePath.endsWith('.pack.json')
                  ? authoredCookedRefs.has(entry.packageUrl)
                    ? AUTHORED_COOKED_CURRENT_PROJECTION
                    : DIRECT_CURRENT_PROJECTION
                  : COOKED_CURRENT_PROJECTION),
                ...(cookedRefs === undefined ? {} : { refs: cookedRefs }),
              },
        );
        continue;
      }
      // emitFile name '<guid-lowercase>' (D-2) + originalFileName for
      // Rollup's automatic addWatchFile hook (research F1). The imported bytes
      // (rgba8 / rgba16float) come from the shared import fn; the packageUrl
      // rewrite (emitFile + getFileName) stays here, the build arm owning it.
      // (B) Texture arm build: compress after importTextureEntry, before emitFile (D-3).
      // AC-01: honor an explicit importSettings.compression override from the meta.
      const texBuildOverride = await readOverrideFromMeta(
        guidToMetaBuild.get(entry.guid.toLowerCase()),
      );
      const compressedTex = await compressArtifact({
        bytes: imported.bytes,
        kind: 'texture',
        isPackJson: false,
        ...(texBuildOverride !== undefined ? { override: texBuildOverride } : {}),
        // Carry the importer's resolved delivery encoding so a Basis KTX2 row
        // records its basis-* discriminant (loader transcode dispatch) instead
        // of the STRATEGY_TABLE 'none' default (which fell through to a scheme=1
        // KTX2 reject). Build path SSOT with the dev arm.
        ...(imported.metadata.compression !== undefined
          ? { alreadyCompressed: imported.metadata.compression }
          : {}),
      });
      const texturePackagePath = `assets/${entry.guid.toLowerCase()}.pack.json`;
      const artifactCodec =
        compressedTex.compression === 'basis-etc1s'
          ? { name: 'basis', profile: 'etc1s' }
          : compressedTex.compression === 'basis-uastc'
            ? { name: 'basis', profile: 'uastc-ldr' }
            : compressedTex.compression === 'basis-uastc-hdr'
              ? { name: 'basis', profile: 'uastc-hdr' }
              : undefined;
      const texturePackage = await finalizePackage(
        {
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: entry.guid,
              kind: entry.kind,
              payload: {
                kind: entry.kind,
                width: imported.metadata.width ?? 0,
                height: imported.metadata.height ?? 0,
                format: imported.metadata.format,
                colorSpace: imported.metadata.colorSpace,
                mipmap: imported.metadata.mipmap,
              },
              refs: [],
              artifacts: {
                body: {
                  mediaType: 'application/octet-stream',
                  ...(artifactCodec === undefined ? {} : { assetCodec: artifactCodec }),
                  bytes: compressedTex.compressed,
                },
              },
            },
          ],
        },
        { write: () => {} },
        {
          base: basePrefix === '' ? '/' : basePrefix,
          packagePath: texturePackagePath,
          artifactPath: (guid) => `${guid.toLowerCase()}/body.bin`,
        },
      );
      for (const artifact of texturePackage.artifacts) {
        await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
      }
      this.emitFile({
        type: 'asset',
        fileName: texturePackagePath,
        originalFileName: resolve(cwd, entry.sourcePath),
        source: JSON.stringify(texturePackage.pack),
      });
      const texturePackageUrl = texturePackage.packageUrl;
      importedEntries.push({
        // Keep the catalog's producer-owned identity/projection facts when the
        // package URL moves from authored source to the shipped DDC package.
        // Rebuilding this row from only four fields made production builds
        // lose `name`, `sourcePath`, and imported-output lifecycle evidence;
        // runtime then fell back to the generated GUID pack filename even
        // though the authored source was still `sky.hdr`.
        ...entry,
        packageUrl: texturePackageUrl,
        ...COOKED_CURRENT_PROJECTION,
      });
    }

    // M4 / w33 (AC-21): full pre-import for the shipped form. For every meta
    // sidecar, call the import runner to produce the DDC (.pack.json) and emit
    // it as a Rollup asset. This ensures the shipped bundle carries all DDC
    // artefacts, not just the texture .bin import output. After this step the
    // catalog entries' packageUrl fields point to the hashed asset paths
    // (Rollup names), matching the import step's convention.
    //
    // For meta files whose DDC already exists on disk (e.g. pre-generated by
    // the CLI), the import runner re-imports them idempotently (GUID
    // import-stable iron law produces the same output). The runner also
    // validates the GUID set; `importer: 'shader'` is skipped.
    //
    // guidToMetaBuild (built above the texture arm) tells us which meta declares
    // each entry's GUID. Group entries by their declaring meta so we call
    // `runImport` once per meta (one pass produces all sub-assets).
    const guidSeen = new Set<string>();
    const finalizedUiUrls = new Map<string, string>();
    const emittedPackUrls = new Map<string, string>();

    for (const entry of importedEntries) {
      if (guidSeen.has(entry.guid.toLowerCase())) continue;
      const metaPath = guidToMetaBuild.get(entry.guid.toLowerCase());
      if (metaPath === undefined) {
        // Self-contained packs are already final payloads. Emit each source
        // pack once and point every asset row in that pack at the shipped
        // Rollup asset. They must not enter the importer/DDC path.
        if (entry.sourcePath.endsWith('.pack.json')) {
          let packUrl = emittedPackUrls.get(entry.sourcePath);
          if (packUrl === undefined) {
            packUrl = authoredPackUrlsBySource.get(entry.sourcePath);
          }
          if (packUrl === undefined) {
            const packPath = resolve(cwd, entry.sourcePath);
            const packRef = this.emitFile({
              type: 'asset',
              name: `${entry.guid.toLowerCase()}.pack.json`,
              originalFileName: packPath,
              source: await readFile(packPath, 'utf-8'),
            });
            packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
            emittedPackUrls.set(entry.sourcePath, packUrl);
          } else {
            emittedPackUrls.set(entry.sourcePath, packUrl);
          }
          for (let index = 0; index < importedEntries.length; index += 1) {
            const candidate = importedEntries[index];
            if (candidate?.sourcePath === entry.sourcePath) {
              importedEntries[index] = { ...candidate, packageUrl: packUrl };
            }
          }
        }
        // Non-meta rows are already final and do not need an importer.
        guidSeen.add(entry.guid.toLowerCase());
        continue;
      }

      // Parse the meta and call runImport for the whole sidecar at once.
      let rm: unknown;
      try {
        rm = JSON.parse(await readFile(metaPath, 'utf-8'));
      } catch {
        // Skip unreadable meta; the entry stays in the catalog as-is.
        guidSeen.add(entry.guid.toLowerCase());
        continue;
      }
      const meta = rm as {
        importer: string;
        source?: string;
        importSettings?: unknown;
        sourceOverrides?: unknown;
        subAssets: ReadonlyArray<{ guid: string; sourceIndex: number; kind: string }>;
      };
      const subAssets = meta.subAssets;

      // Mark all sub-asset GUIDs as seen so we don't re-import this meta twice.
      for (const sub of subAssets) {
        guidSeen.add(sub.guid.toLowerCase());
      }

      // Pass1 (the import step above) already decoded these images, emitted the
      // hashed `.bin`, and folded width/height/format/colorSpace/mipmap into the
      // pack-index row's `packageUrl` + `metadata`. The runtime textureLoader
      // dispatches on `entry.kind === 'texture'` and reads only that `.bin` + the
      // inline pack-index metadata; it never fetches the per-image `.pack.json`
      // that runImport would emit here. Re-running the full import for an
      // `importer: 'image'` meta therefore re-decodes every image a second time
      // and emits a `.pack.json` Rollup asset nothing consumes. Skip it. glTF /
      // FBX metas (whose texture sub-assets are a disjoint GUID set produced by
      // their own importer) and any other importer still flow through below.
      if (meta.importer === 'image') {
        continue;
      }

      const sourceResult = resolveAssetSource(metaPath, meta.source, paths);
      if (!sourceResult.ok) {
        console.warn(
          `[forgeax-pack] source resolution failed for ${metaPath}: ${sourceResult.error.code} — skipping pre-import`,
        );
        continue;
      }

      const runMeta: RunImportMeta = {
        importer: meta.importer,
        source: sourceResult.value,
        subAssets,
        buildPack: false,
      };
      if (meta.importSettings !== undefined) {
        (runMeta as { importSettings?: Readonly<Record<string, unknown>> }).importSettings =
          meta.importSettings as Readonly<Record<string, unknown>>;
      }
      if (meta.sourceOverrides !== undefined) {
        (runMeta as { sourceOverrides?: unknown }).sourceOverrides = meta.sourceOverrides;
      }

      const runResult = await runImport(runMeta, importerRegistry, fsForImport);
      if (!runResult.ok) {
        const reason =
          (runResult.error.detail as { reason?: string } | undefined)?.reason ??
          runResult.error.hint ??
          '';
        if (runResult.error.code === 'importer-not-registered') {
          throw new Error(
            `[forgeax-pack] no importer registered for ${metaPath}; raw-source fallback is forbidden (${reason})`,
          );
        }
        // Any other failure means a WIRED importer failed to convert the source
        // (e.g. fbx-mesh-type-unsupported surfacing as import-internal-error). The
        // .pack.json DDC never overlays the catalog, so the build would emit a
        // pack-index pointing at the raw source and ship a guaranteed
        // blank-screen demo with only a stderr warning. Fail-fast
        // (architecture-principles §5 + AGENTS.md "demo failures route to engine
        // fixes") so the gap can never be mistaken for a green build.
        throw new Error(
          `[forgeax-pack] pre-import failed for ${metaPath}: ${runResult.error.code} - ${reason}`,
        );
      }
      if ('skipped' in runResult.value) {
        throw new Error(
          `[forgeax-pack] importer skipped ${metaPath}: ${runResult.value.skipped}; cooked runtime output is required`,
        );
      }

      if (meta.importer === 'ui') {
        const uiGuid = subAssets[0]?.guid;
        if (uiGuid === undefined) continue;
        const artifactPaths = new Map<string, string>();
        const uiAsset = runResult.value.product.assets[0];
        const transportArtifacts = projectUiBuildArtifacts(
          Object.entries(uiAsset?.artifacts ?? {}).map(([path, artifact]) => ({
            path,
            mimeType: artifact.mediaType,
            bytes: artifact.bytes,
          })),
          (artifact) => artifact.path,
        );
        for (const artifact of transportArtifacts) {
          const ref = this.emitFile({
            type: 'asset',
            name: artifact.path,
            originalFileName: artifact.path,
            source: artifact.bytes,
          });
          artifactPaths.set(artifact.path, this.getFileName(ref));
        }
        const finalized = finalizeUiArtifact(runResult.value.product as never, {
          artifactUrl: (artifact) =>
            projectPackIndexUrl(basePrefix, artifactPaths.get(artifact.path) ?? artifact.path),
        });
        if (!finalized.ok) {
          throw new Error(
            `[forgeax-pack] UI finalizer failed for ${metaPath}: ${finalized.error.code}`,
          );
        }
        const uiProduct = {
          ...runResult.value.product,
          assets: runResult.value.product.assets.map((asset, index) =>
            index === 0 ? { ...asset, payload: finalized.value.asset } : asset,
          ),
        };
        const uiPackage = await finalizePackage(
          projectAssetProduction(uiProduct).logicalPackage,
          { write: () => {} },
          {
            base: basePrefix,
            packagePath: `assets/${uiGuid}.pack.json`,
            artifactPath: (_guid, key) => {
              const emittedPath = artifactPaths.get(key);
              if (emittedPath === undefined) {
                throw new Error(`UI artifact ${key} was not emitted for ${metaPath}`);
              }
              return emittedPath.replace(/^assets\//, '');
            },
          },
        );
        const uiRef = this.emitFile({
          type: 'asset',
          name: `${uiGuid}.pack.json`,
          originalFileName: metaPath,
          source: JSON.stringify(uiPackage.pack),
        });
        const uiPath = projectPackIndexUrl(basePrefix, this.getFileName(uiRef));
        finalizedUiUrls.set(uiGuid.toLowerCase(), uiPath);
        const rowIndex = importedEntries.findIndex(
          (entry) => entry.guid.toLowerCase() === uiGuid.toLowerCase(),
        );
        if (rowIndex >= 0 && importedEntries[rowIndex] !== undefined) {
          importedEntries[rowIndex] = { ...importedEntries[rowIndex], packageUrl: uiPath };
        }
        continue;
      }

      // Emit the .pack.json DDC as a small Rollup asset. Binary artifacts are
      // staged separately so Rollup never retains the complete cooked product
      // graph while rendering the application bundle.
      // Project the product once, then stop retaining the importer-owned POD
      // graph. `logicalPackageFromImportProduct` removes inline mesh/texture
      // payload bytes when the asset already has a body artifact; keeping the
      // original product alive through finalization would otherwise retain a
      // second large graph beside the artifact bytes.
      const importedProduct = runResult.value.product;
      const logicalPackage = projectAssetProduction(importedProduct).logicalPackage;
      const productByGuid = productAssetsByGuid(importedProduct);
      const packagePath = `assets/${subAssets[0]?.guid ?? 'pack'}.pack.json`;
      const finalized = await finalizePackage(
        logicalPackage,
        { write: () => {} },
        {
          base: basePrefix,
          packagePath,
          artifactPath: (guid, key) => `${guid}-${key}.bin`,
        },
      );
      for (const artifact of finalized.artifacts) {
        await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
      }
      const pack = finalized.pack;
      const packJson = JSON.stringify(pack);
      const packRef = this.emitFile({
        type: 'asset',
        name: `${subAssets[0]?.guid ?? 'pack'}.pack.json`,
        originalFileName: metaPath,
        source: packJson,
      });
      const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));

      // Update all entries from this meta to point to the Pack v2 envelope.
      for (const sub of subAssets) {
        const idx = importedEntries.findIndex(
          (e) => e.guid.toLowerCase() === sub.guid.toLowerCase(),
        );
        if (idx >= 0 && importedEntries[idx] !== undefined) {
          const existing = importedEntries[idx];
          if (existing !== undefined) {
            // Carry the DDC's outgoing dependency edges into the shipped
            // pack-index row so the prod Content Browser dependency graph
            // sees them without re-fetching the .pack.json body.
            const ddcAsset = productByGuid.get(sub.guid.toLowerCase());
            importedEntries[idx] = {
              ...existing,
              packageUrl: packUrl,
              ...COOKED_CURRENT_PROJECTION,
              ...(ddcAsset?.refs !== undefined
                ? { refs: ddcAsset.refs.map((ref) => ref.guid) }
                : {}),
            };
          }
        }
      }
    }

    const productionCatalog = dedupeFinalizedUiEntries(importedEntries, finalizedUiUrls);
    this.emitFile({
      type: 'asset',
      fileName: 'pack-index.json',
      source: JSON.stringify(productionCatalog),
    });
  }

  async function writeBundle(options: { readonly dir?: string | undefined }): Promise<void> {
    const factsDir = process.env.FORGEAX_BUILD_METRICS_DIR;
    if (factsDir !== undefined) {
      try {
        mkdirSync(factsDir, { recursive: true });
        const metrics = readDdcMetrics();
        writeFileSync(
          resolve(factsDir, `pack-${process.pid}.json`),
          `${JSON.stringify({
            assetCookHitCount: metrics.hitCount,
            assetCookMissCount: metrics.missCount,
            assetCookWriteFailureCount: metrics.writeFailureCount,
          })}\n`,
        );
      } catch {
        // Build facts are diagnostic only; cache failures remain fail-open.
      }
    }
    const stage = buildArtifactStage;
    if (stage === undefined) return;
    if (options.dir === undefined) {
      throw new Error('forgeax:pack staged artifacts require a directory output');
    }
    const outputDir = resolve(process.cwd(), options.dir);
    try {
      for (const relative of stage.files) {
        const source = resolve(stage.root, relative);
        const destination = resolve(outputDir, relative);
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
      }
    } finally {
      await rm(stage.root, { recursive: true, force: true });
      buildArtifactStage = undefined;
    }
  }

  async function closeBundle(): Promise<void> {
    const stage = buildArtifactStage;
    buildArtifactStage = undefined;
    if (stage !== undefined) await rm(stage.root, { recursive: true, force: true });
  }

  return {
    name: 'forgeax:pack',
    configureServer,
    generateBundle,
    writeBundle,
    closeBundle,
  };
}

/** Package version string (debug tag). */
export const VITE_PLUGIN_PACK_PACKAGE_VERSION = '0.0.0';
