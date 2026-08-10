// @forgeax/engine-vite-plugin-pack — Vite plugin for the forgeax engine asset package system.
//
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  type Importer,
  type PackIndexEntry,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
  type RuntimeAssetBinding,
  runtimeScopePath,
} from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { projectAssetProduction } from './build/asset-production.js';
import { createPluginBuild, type MinimalPluginContext } from './build/plugin-build.js';
import { type CatalogLegacyProjection, currentProjectionFor } from './build-catalog.js';
import type { AssetHostRefreshPolicy } from './catalog-client.js';
import { compressArtifact } from './compress-artifact.js';
import { resolveDdcRoot, semanticDdcKey } from './ddc-cache.js';
import { publishImportPublication } from './dev/import-publication.js';
import { runNativeCookerLifecycle } from './dev/native-cooker-lifecycle.js';
import { createPackageRoutes } from './dev/package-routes.js';
import { createPluginServer, type PluginServerLike } from './dev/plugin-server.js';
import { createUiDependencyIndex } from './dev/ui-dependency-index.js';
import { productAssetByGuid, productBinaryArtifacts } from './import-products.js';
import { importTextureEntry } from './import-texture.js';
import {
  finalizePackage,
  type LogicalPackage,
  type LogicalPackageAsset,
} from './package-finalizer.js';
import type { ProducerReadiness } from './producer/source-package.js';
import { PackRuntimeRealm } from './runtime-realm.js';
import { finalizeUiArtifact } from './ui-pack-finalizer.js';

export { projectAssetProduction } from './build/asset-production.js';
export { CATALOG_DELTA_EVENT, createCatalogClient, reloadAssetHost } from './catalog-client.js';
export { ASSET_CHANGED_EVENT, type AssetChangedPayload } from './dev/events.js';
export {
  type NativeCookerLifecycleOptions,
  type NativeCookerLifecycleResult,
  type NativeCookerLifecycleSnapshot,
  runNativeCookerLifecycle,
} from './dev/native-cooker-lifecycle.js';
export {
  createMaterialCookFinalizer,
  type MaterialArtifactSink,
  type MaterialCookCatalogEntry,
  type MaterialCookFinalizerOptions,
  type MaterialCookRequest,
  writeMaterialCookResult,
} from './material/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type { ProducerReadiness } from './producer/source-package.js';
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
/** Shape of the plugin returned by pluginPack(). */
export interface ForgeaXPackPlugin {
  readonly name: string;
  readonly rebind: (
    binding: RuntimeAssetBinding,
    roots: readonly string[],
  ) => Promise<RuntimeAssetBinding>;
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  configureServer(server: PluginServerLike): void;
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
   * Controls when configured source Meta packages become consumable in serve
   * mode. Browser hosts use the default before-consume policy; Studio may opt
   * into the existing request-triggered path explicitly.
   */
  readonly producerReadiness?: ProducerReadiness | undefined;
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
  /** Host-owned build-input boundary excluded from Pack catalog discovery. */
  readonly ignorePath?: (path: string) => boolean;
  /** Optional fixed single-game binding for standalone/static dev hosts. */
  readonly runtimeBinding?: RuntimeAssetBinding;
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

/** Read an explicit per-asset compression override from import settings. */
function readCompressionOverride(importSettings: unknown): 'none' | 'zstd' | undefined {
  if (importSettings === null || typeof importSettings !== 'object') return undefined;
  const compression = (importSettings as { compression?: unknown }).compression;
  return compression === 'none' || compression === 'zstd' ? compression : undefined;
}

/** Read a compression override from a meta sidecar when one is available. */
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

// Dev import DDC (Derived Data Cache) location. The imported `.bin` is derived
// data -- delete it and the next `loadByGuid` re-derives it from the source.
// Keying it by GUID under `node_modules/.cache/forgeax-ddc/` keeps it gitignored
// everywhere (root `node_modules/` rule) so it never pollutes the source tree,
// which for vendor assets (e.g. Sponza textures) is a tracked git submodule.
// Deterministic from `(cwd, guid)`: the write site (importOneTexture) and the
// warm-refresh reconstruction site (buildUrlToAbs) MUST agree on this formula.
// GUIDs are globally unique (UUIDv5/v7 per sub-asset), so no collision with the
// build arm's `dist/assets/<guid>-<hash>.bin` Rollup namespace.
function runtimeDdcRoot(cwd: string, binding: RuntimeAssetBinding | undefined): string {
  const scope =
    binding === undefined
      ? 'unbound'
      : `${binding.scopeId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${binding.generation}`;
  return resolve(resolveDdcRoot(cwd), 'runtime', scope);
}

function ddcPath(cwd: string, guidLower: string, binding?: RuntimeAssetBinding): string {
  return resolve(runtimeDdcRoot(cwd, binding), `${guidLower}.bin`);
}

// ─── Main factory ───────────────────────────────────────────────────────────

/** Vite plugin factory for the ForgeaX asset package system. */
export function pluginPack(opts: PluginPackOptions = {}): ForgeaXPackPlugin {
  const runtimeRealm = new PackRuntimeRealm();
  // Mutable catalog state — rebuilt on startup and on file watch events.
  let catalog: PackIndexEntry[] = [];
  let catalogProjection: CatalogLegacyProjection = {
    schemaVersion: 'catalog-legacy-v1',
    entries: [],
    authority: 'authoritative',
    diagnostics: [],
  };
  let degradedCatalogEntries: PackIndexEntry[] = [];
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
  let packageRoutes = createPackageRoutes();
  const nativeCookerRegistry = new NativeCookerRegistry();
  for (const cooker of opts.cookers ?? []) nativeCookerRegistry.register(cooker);

  function resetDevState(): void {
    catalog = [];
    catalogProjection = {
      schemaVersion: 'catalog-legacy-v1',
      entries: [],
      authority: 'authoritative',
      diagnostics: [],
    };
    degradedCatalogEntries = [];
    urlToAbs = new Map();
    guidToMeta = new Map();
    importedRows.clear();
    inFlightImports.clear();
    inFlightMetaImports.clear();
    metaPackBodies.clear();
    devArtifactBodies.clear();
    packageRoutes.invalidate();
    packageRoutes = createPackageRoutes();
    catalogReady = false;
  }

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
      const result = await runNativeCookerLifecycle({
        registry: nativeCookerRegistry,
        key: asset.kind,
        input: { guid: asset.guid, source: asset.payload },
      });
      if (!result.ok) {
        throw new Error(
          `[forgeax-pack] native cook failed for ${asset.guid}: ${result.error.code} — ${result.error.hint}`,
        );
      }
      const draft = result.value.draft;
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
    degradedCatalogEntries = projection.authority === 'degraded' ? [...projection.entries] : [];
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

  function scopedPackageUrl(binding: RuntimeAssetBinding, packageUrl: string): string {
    const base = binding.packageUrlBase.replace(/\/+$/, '');
    const rawUrl = packageUrl.startsWith('/') ? packageUrl : `/${packageUrl}`;
    const scopedNamespace = runtimeScopePath(binding, 'asset');
    const hostBase = base.endsWith(scopedNamespace) ? base.slice(0, -scopedNamespace.length) : '';
    const internalUrl =
      hostBase.length > 0 && (rawUrl === hostBase || rawUrl.startsWith(`${hostBase}/`))
        ? rawUrl.slice(hostBase.length) || '/'
        : rawUrl;
    const scopedPath = runtimeScopePath(binding, `asset${internalUrl}`);
    if (base.length === 0) return scopedPath;
    return base.endsWith(scopedNamespace) ? `${base}${internalUrl}` : `${base}${scopedPath}`;
  }

  function scopedCatalogResponse(binding: RuntimeAssetBinding) {
    const response = legacyCatalogResponse();
    const entries =
      'authority' in response
        ? response.entries.length > 0
          ? response.entries
          : degradedCatalogEntries
        : response;
    const diagnostics =
      'authority' in response
        ? response.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            severity: 'blocking' as const,
            message: diagnostic.message,
            ...(diagnostic.expected === undefined ? {} : { expected: diagnostic.expected }),
            ...(diagnostic.actual === undefined ? {} : { actual: diagnostic.actual }),
            ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
          }))
        : [];
    return {
      schemaVersion: RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      scopeId: binding.scopeId,
      generation: binding.generation,
      authority: 'authority' in response ? response.authority : ('authoritative' as const),
      entries: entries.map((entry) => ({
        ...entry,
        packageUrl: scopedPackageUrl(binding, entry.packageUrl),
      })),
      diagnostics,
    };
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
    const binAbs = ddcPath(process.cwd(), guidLower, runtimeRealm.snapshot()?.binding);
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
    const scopeBinding = runtimeRealm.snapshot()?.binding;
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
        const binAbs = ddcPath(cwd, guidLower, scopeBinding);
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
          const packPath = ddcPath(cwd, `${firstSubGuid}.meta.pack`, scopeBinding);
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

  const serverLifecycle = createPluginServer({
    opts,
    registeredImporterKeys,
    runtimeRealm,
    resetState: resetDevState,
    scopedPackageUrl,
    scopedCatalogResponse,
    state: {
      get catalog() {
        return catalog;
      },
      set catalog(value) {
        catalog = value;
      },
      get catalogProjection() {
        return catalogProjection;
      },
      set catalogProjection(value) {
        catalogProjection = value;
      },
      get urlToAbs() {
        return urlToAbs;
      },
      set urlToAbs(value) {
        urlToAbs = value;
      },
      get catalogReady() {
        return catalogReady;
      },
      set catalogReady(value) {
        catalogReady = value;
      },
      get guidToMeta() {
        return guidToMeta;
      },
      set guidToMeta(value) {
        guidToMeta = value;
      },
      importedRows,
      metaPackBodies,
      devArtifactBodies,
      inFlightImports,
      inFlightMetaImports,
      uiDependencies,
    },
    callbacks: {
      installCatalogProjection,
      publishAuthoredDevPacks,
      legacyCatalogResponse,
      importOneTexture,
      startMetaImport,
      ensureMetaPackBody,
      ddcPath,
      setCatalogDeltaPublisher: (publisher) => {
        publishCatalogDelta = publisher;
      },
      preserveInvalidatedCatalogLkg,
    },
  });
  const configureServer = serverLifecycle.configureServer;
  const rebind = serverLifecycle.rebind;
  const runtimeBinding = serverLifecycle.runtimeBinding;
  const buildLifecycle = createPluginBuild({
    opts,
    registeredImporterKeys,
    importerRegistry,
    fsForImport,
    callbacks: {
      upgradeLegacyAuthoredPack,
      readCookedAuthoredPack,
    },
    cookedCurrentProjection: COOKED_CURRENT_PROJECTION,
    directCurrentProjection: DIRECT_CURRENT_PROJECTION,
    authoredCookedCurrentProjection: AUTHORED_COOKED_CURRENT_PROJECTION,
  });
  return {
    name: 'forgeax:pack',
    rebind,
    runtimeBinding,
    configureServer,
    generateBundle: buildLifecycle.generateBundle,
    writeBundle: buildLifecycle.writeBundle,
    closeBundle: async () => {
      serverLifecycle.close();
      await buildLifecycle.closeBundle();
    },
  };
}

/** Package version string (debug tag). */
