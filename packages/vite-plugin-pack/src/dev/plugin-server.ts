import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  CatalogDelta,
  PackIndexEntry,
  RuntimeAssetBinding,
  RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';
import {
  buildCatalogProjection,
  type CatalogBuildError,
  type CatalogLegacyProjection,
} from '../build-catalog.js';
import { CATALOG_DELTA_EVENT } from '../catalog-client.js';
import { calculateCatalogDelta } from '../catalog-watch.js';
import type { PluginPackOptions } from '../index.js';
import { parseProducerReadiness } from '../producer/source-package.js';
import { normalizeSourcePackageError } from '../producer/source-package-errors.js';
import type { PackRuntimeRealm } from '../runtime-realm.js';
import { resolvePackBuildInputs } from '../shared-build-inputs.js';
import { createAssetChangedEvent, emitAssetChanged } from './asset-change-events.js';
import { projectSourcePackageFailure } from './package-routes.js';
import {
  buildGuidToMetaMap,
  buildUrlToAbsolute,
  type WatchBatch,
  watchDevRoots,
} from './watcher.js';

export interface PluginServerLike {
  readonly middlewares: {
    use(handler: ConnectMiddleware): unknown;
  };
  readonly ws?: {
    send(payload: { type: string } & Record<string, unknown>): void;
  };
}

interface ServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

interface IncomingMessageLike {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
}

type NextHandleFunction = (err?: unknown) => void;
type ConnectMiddleware = (
  req: IncomingMessageLike,
  res: ServerResponseLike,
  next: NextHandleFunction,
) => void | Promise<void>;

interface PluginServerState {
  catalog: PackIndexEntry[];
  catalogProjection: CatalogLegacyProjection;
  urlToAbs: Map<string, string>;
  catalogReady: boolean;
  guidToMeta: Map<string, string>;
  importedRows: Map<string, PackIndexEntry>;
  metaPackBodies: Map<string, string>;
  devArtifactBodies: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>;
  inFlightImports: Map<string, Promise<PackIndexEntry[]>>;
  inFlightMetaImports: Map<string, Promise<PackIndexEntry[]>>;
  uiDependencies: {
    guidsForSource(sourcePath: string): readonly string[];
  };
}

interface PluginServerCallbacks {
  installCatalogProjection(projection: CatalogLegacyProjection): void;
  publishAuthoredDevPacks(entries: readonly PackIndexEntry[]): Promise<readonly PackIndexEntry[]>;
  legacyCatalogResponse(): readonly PackIndexEntry[] | CatalogLegacyProjection;
  importOneTexture(guidLower: string): Promise<PackIndexEntry[]>;
  startMetaImport(metaPath: string): Promise<PackIndexEntry[]>;
  ensureMetaPackBody(url: string): Promise<string | undefined>;
  ddcPath(cwd: string, guidLower: string, binding?: RuntimeAssetBinding): string;
  setCatalogDeltaPublisher(publisher: (delta: CatalogDelta) => void): void;
  preserveInvalidatedCatalogLkg(
    previousCatalog: readonly PackIndexEntry[],
    nextCatalog: readonly PackIndexEntry[],
    invalidatedGuids: ReadonlySet<string>,
  ): PackIndexEntry[];
}

interface PluginServerContext {
  readonly opts: PluginPackOptions;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly runtimeRealm: PackRuntimeRealm;
  readonly resetState: () => void;
  readonly scopedPackageUrl: (binding: RuntimeAssetBinding, packageUrl: string) => string;
  readonly scopedCatalogResponse: (binding: RuntimeAssetBinding) => RuntimeCatalogSnapshot;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
}

export interface PluginServerLifecycle {
  readonly configureServer: (server: PluginServerLike) => void;
  readonly rebind: (
    binding: RuntimeAssetBinding,
    roots: readonly string[],
  ) => Promise<RuntimeAssetBinding>;
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  readonly close: () => void;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function mimeFromPath(path: string): 'image/jpeg' | 'image/png' | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return undefined;
}

export function createPluginServer(context: PluginServerContext) {
  const {
    opts,
    registeredImporterKeys,
    runtimeRealm,
    resetState,
    scopedPackageUrl,
    scopedCatalogResponse,
    state,
    callbacks,
  } = context;
  let roots = [...resolvePackBuildInputs(opts).roots];
  let startupReady: Promise<void> = Promise.resolve();
  let resolveStartupReady: (() => void) | undefined;
  let stopWatcher: () => void = () => {};
  let configuredServer: PluginServerLike | undefined;
  let configured = false;
  let runtimeToken: number | undefined;
  const scanOptions = opts.ignorePath === undefined ? {} : { ignorePath: opts.ignorePath };
  const ensureMetaImport = (metaPath: string): Promise<PackIndexEntry[]> => {
    const existing = state.inFlightMetaImports.get(metaPath);
    if (existing !== undefined) return existing;
    const current = callbacks.startMetaImport(metaPath).finally(() => {
      state.inFlightMetaImports.delete(metaPath);
    });
    state.inFlightMetaImports.set(metaPath, current);
    return current;
  };
  const settleMetaImports = async (metaPaths: readonly string[]): Promise<void> => {
    await Promise.all(
      metaPaths.map(async (metaPath) => {
        try {
          await ensureMetaImport(metaPath);
        } catch (error) {
          const affectedGuids = [...state.guidToMeta.entries()]
            .filter(([, declaredMetaPath]) => declaredMetaPath === metaPath)
            .map(([guid]) => guid);
          const firstGuid = affectedGuids[0] ?? metaPath;
          const normalized = normalizeSourcePackageError(error, {
            sourceMeta: metaPath,
            anchorGuid: firstGuid,
            affectedGuids,
            producer: 'source-package',
            importer: 'unknown',
          });
          state.catalog = projectSourcePackageFailure(state.catalog, normalized);
        }
      }),
    );
  };
  const runtimeDiagnostics = (
    diagnostics: readonly {
      readonly code: string;
      readonly message: string;
      readonly expected?: string;
      readonly actual?: string;
      readonly hint?: string;
    }[],
  ): RuntimeAssetBinding['diagnostics'] =>
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: 'blocking' as const,
      message: diagnostic.message,
      ...(diagnostic.expected === undefined ? {} : { expected: diagnostic.expected }),
      ...(diagnostic.actual === undefined ? {} : { actual: diagnostic.actual }),
      ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    }));
  const configureServer = (server: PluginServerLike, overrideRoots?: readonly string[]): void => {
    configuredServer = server;
    configured = true;
    callbacks.setCatalogDeltaPublisher((delta) => {
      const binding = runtimeRealm.snapshot()?.binding;
      server.ws?.send({
        type: 'custom',
        event: CATALOG_DELTA_EVENT,
        data:
          binding === undefined
            ? delta
            : { ...delta, scopeId: binding.scopeId, generation: binding.generation },
      });
    });
    // Async startup: scan roots to build the initial state.catalog.
    roots = [...(overrideRoots ?? resolvePackBuildInputs(opts).roots)];
    if (opts.runtimeBinding !== undefined && runtimeRealm.snapshot() === undefined) {
      runtimeToken = runtimeRealm.beginBind(opts.runtimeBinding, roots);
    }
    // Install the watcher before the async initial scan. A host can edit an
    // asset as soon as the dev server exists; delaying watch registration until
    // the scan resolves loses that first mutation (and its refresh signal).
    startupReady = new Promise<void>((resolve) => {
      resolveStartupReady = resolve;
    });
    let applyWatchBatch: ((batch: WatchBatch) => Promise<void>) | undefined;
    let serialBatches = Promise.resolve();
    stopWatcher = watchDevRoots({
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
      buildCatalogProjection(roots, opts.base, registeredImporterKeys, scanOptions),
      buildGuidToMetaMap(roots, scanOptions),
    ])
      .then(async ([rawProjection, g2m]) => {
        const readiness = parseProducerReadiness(opts.producerReadiness);
        if (!readiness.ok) {
          state.catalog = [];
          const diagnostic: CatalogBuildError = {
            code: 'catalog-scan-failed',
            path: 'pluginPack.producerReadiness',
            message: readiness.error.hint,
            expected: readiness.error.expected,
            actual: String(readiness.error.detail.value),
            hint: readiness.error.hint,
          };
          state.catalogProjection = {
            schemaVersion: 'catalog-legacy-v1',
            entries: [],
            authority: 'degraded',
            diagnostics: [diagnostic],
          };
          state.catalogReady = true;
          resolveStartupReady?.();
          return;
        }
        // The dev state.catalog passes the discoverable bare-source texture rows
        // straight through, with the per-asset import overlay applied so any
        // already-imported `.bin` row survives the rebuild (monotonic import).
        // The runtime loader (import-on-demand sentinel) routes any non-`.bin`
        // texture row to the dev transport for lazy import; keeping the row
        // discoverable is the precondition for Sponza's state.catalog-first
        // findTextureGuidByFilename.
        callbacks.installCatalogProjection({
          ...rawProjection,
          entries: await callbacks.publishAuthoredDevPacks(rawProjection.entries),
        });
        state.guidToMeta = g2m;
        state.urlToAbs = buildUrlToAbsolute(state.catalog, {
          cwd: process.cwd(),
          ddcPath: (guid) =>
            callbacks.ddcPath(process.cwd(), guid, runtimeRealm.snapshot()?.binding),
        });
        if (readiness.value === 'before-consume') {
          const metaPaths = [...new Set(g2m.values())];
          await settleMetaImports(metaPaths);
          state.catalogProjection = {
            ...state.catalogProjection,
            entries: rawProjection.authority === 'degraded' ? rawProjection.entries : state.catalog,
          };
          state.urlToAbs = buildUrlToAbsolute(state.catalog, {
            cwd: process.cwd(),
            ddcPath: (guid) =>
              callbacks.ddcPath(process.cwd(), guid, runtimeRealm.snapshot()?.binding),
          });
        }
        state.catalogReady = true;
        const binding = runtimeRealm.snapshot()?.binding;
        if (binding?.status === 'transitioning' && runtimeToken !== undefined) {
          runtimeRealm.publish(
            runtimeToken,
            rawProjection.authority === 'authoritative' ? 'ready' : 'degraded',
            rawProjection.authority,
            runtimeDiagnostics(rawProjection.diagnostics),
          );
        }

        applyWatchBatch = async ({ sidecars, sources }) => {
          let catalogChanged = false;
          // A source edit invalidates the dev DDC overlay for rows whose
          // declaring source changed. Without this, the full-reload signal
          // reaches the browser but POST /__import returns the stale
          // imported row from `state.importedRows` before the importer runs again.
          // Resolve both watcher-relative filenames and state.catalog-relative
          // source paths against their owning roots/cwd so this remains
          // correct for roots outside the Vite project directory.
          const changedSourcePaths = new Set<string>();
          for (const info of sources) {
            changedSourcePaths.add(resolve(info.filename));
            for (const root of roots) changedSourcePaths.add(resolve(root, info.filename));
          }
          const invalidatedPackUrls = new Set<string>();
          const invalidatedGuids = new Set<string>();
          for (const [guid, row] of state.importedRows) {
            if (!changedSourcePaths.has(resolve(process.cwd(), row.sourcePath))) continue;
            invalidatedPackUrls.add(row.packageUrl);
            invalidatedGuids.add(guid);
            state.importedRows.delete(guid);
          }
          for (const packageUrl of invalidatedPackUrls) state.metaPackBodies.delete(packageUrl);
          const importedRowsInvalidated = invalidatedPackUrls.size > 0;

          // Rebuild on every source event, even after the failed import has
          // already removed state.importedRows. The recovery upload still needs to
          // carry the previous Catalog LKG into the fresh missing row.
          if (sidecars.length > 0 || sources.length > 0 || importedRowsInvalidated) {
            const previousCatalog = state.catalog;
            try {
              const [rawProjection2, g2m2] = await Promise.all([
                buildCatalogProjection(roots, opts.base, registeredImporterKeys, scanOptions),
                buildGuidToMetaMap(roots, scanOptions),
              ]);
              const publishedEntries = callbacks.preserveInvalidatedCatalogLkg(
                previousCatalog,
                await callbacks.publishAuthoredDevPacks(rawProjection2.entries),
                invalidatedGuids,
              );
              callbacks.installCatalogProjection({
                ...rawProjection2,
                entries: publishedEntries,
              });
              state.guidToMeta = g2m2;
              const changedMetaPaths = new Set<string>();
              for (const info of sidecars) {
                const candidate = resolve(info.filename);
                for (const metaPath of new Set(g2m2.values())) {
                  if (resolve(metaPath) === candidate) changedMetaPaths.add(metaPath);
                }
              }
              for (const [guid, metaPath] of g2m2) {
                const row = rawProjection2.entries.find(
                  (entry) => entry.guid.toLowerCase() === guid,
                );
                if (
                  row !== undefined &&
                  changedSourcePaths.has(resolve(process.cwd(), row.sourcePath))
                ) {
                  changedMetaPaths.add(metaPath);
                }
              }
              await settleMetaImports([...changedMetaPaths]);
              callbacks.installCatalogProjection({
                ...rawProjection2,
                entries:
                  rawProjection2.authority === 'degraded' ? rawProjection2.entries : state.catalog,
              });
              state.urlToAbs = buildUrlToAbsolute(state.catalog, {
                cwd: process.cwd(),
                ddcPath: (guid) =>
                  callbacks.ddcPath(process.cwd(), guid, runtimeRealm.snapshot()?.binding),
              });
              const delta = calculateCatalogDelta(previousCatalog, state.catalog);
              if (delta !== undefined) {
                catalogChanged = true;
                server.ws?.send({ type: 'custom', event: CATALOG_DELTA_EVENT, data: delta });
              }
            } catch (err: unknown) {
              console.warn('[forgeax-pack] rebuild state.catalog error:', err);
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
              guids: state.uiDependencies.guidsForSource(info.filename),
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
              guids: state.uiDependencies.guidsForSource(info.filename),
            });
            if (event !== undefined) server.ws?.send(event);
          }
          const parts: string[] = [];
          if (sidecars.length > 0) parts.push(`${sidecars.length} sidecar`);
          if (sources.length > 0) parts.push(`${sources.length} source`);
          console.warn(`[forgeax-pack] assets changed: ${parts.join(', ')} (reloaded)`);
        };
        resolveStartupReady?.();
      })
      .catch((err: unknown) => {
        console.warn('[forgeax-pack] startup scan error:', err);
        state.catalogReady = true;
        resolveStartupReady?.();
      });

    interface RuntimeScopeRoute {
      readonly scopeId: string;
      readonly generation: number;
      readonly suffix: string;
    }

    function parseRuntimeScopeRoute(url: string): RuntimeScopeRoute | undefined {
      const match = /^\/__pack\/scopes\/([^/]+)\/(\d+)(\/.*)?$/.exec(url);
      if (match === null) return undefined;
      const encodedScopeId = match[1];
      if (encodedScopeId === undefined) return undefined;
      let scopeId: string;
      try {
        scopeId = decodeURIComponent(encodedScopeId);
      } catch {
        return undefined;
      }
      const generation = Number(match[2]);
      if (!Number.isSafeInteger(generation)) return undefined;
      return { scopeId, generation, suffix: match[3] ?? '/' };
    }

    const waitForCatalog = async (): Promise<void> => {
      if (state.catalogReady) return;
      await startupReady;
    };

    // Register connect middleware for /__pack/* routes + the
    // dev-mode `/pack-index.json` route (charter P4 consistent
    // abstraction: production emits the same file via generateBundle).
    server.middlewares.use(async (req, res, next) => {
      let url = req.url ?? '';
      let scopedBinding: RuntimeAssetBinding | undefined;
      const parsed = parseRuntimeScopeRoute(url);
      if (parsed !== undefined) {
        const current = runtimeRealm.snapshot()?.binding;
        if (current === undefined) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'runtime-scope-unbound' }));
          return;
        }
        if (current.scopeId !== parsed.scopeId) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'runtime-scope-not-found', scopeId: parsed.scopeId }));
          return;
        }
        if (current.generation !== parsed.generation) {
          res.statusCode = 410;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'runtime-scope-generation-expired',
              scopeId: parsed.scopeId,
              generation: parsed.generation,
              currentGeneration: current.generation,
            }),
          );
          return;
        }
        scopedBinding = current;
        if (parsed.suffix === '/catalog.json') {
          await waitForCatalog();
          const latest = runtimeRealm.snapshot()?.binding;
          if (latest === undefined || latest.generation !== parsed.generation) {
            res.statusCode = 410;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'runtime-scope-generation-expired' }));
            return;
          }
          if (latest.status === 'transitioning' || latest.status === 'unavailable') {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'runtime-scope-unavailable', status: latest.status }));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(scopedCatalogResponse(latest)));
          return;
        }
        // Import and package consumers can arrive as soon as Vite starts
        // serving the page. Before-consume must gate them on the same startup
        // completion as catalog reads; returning 503 while the producer is
        // still cooking turns a temporary transition into a false DDC miss.
        await waitForCatalog();
        const latest = runtimeRealm.snapshot()?.binding;
        if (latest === undefined || latest.generation !== parsed.generation) {
          res.statusCode = 410;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'runtime-scope-generation-expired' }));
          return;
        }
        scopedBinding = latest;
        if (latest.status === 'transitioning' || latest.status === 'unavailable') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'runtime-scope-unavailable', status: latest.status }));
          return;
        }
        if (latest.status === 'degraded' || latest.authority === 'degraded') {
          res.statusCode = 409;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'runtime-scope-catalog-degraded',
              diagnostics: latest.diagnostics ?? [],
            }),
          );
          return;
        }
        if (parsed.suffix.startsWith('/import/')) {
          const guid = parsed.suffix.slice('/import/'.length);
          if (guid.length === 0 || guid.includes('/')) {
            res.statusCode = 404;
            res.end('');
            return;
          }
          url = `/__import/${guid}`;
        } else if (parsed.suffix.startsWith('/asset/')) {
          url = parsed.suffix.slice('/asset'.length);
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'runtime-scope-route-not-found' }));
          return;
        }
      }
      const requiresRuntimeScope =
        url === '/__pack/index' ||
        url === '/pack-index.json' ||
        url.startsWith('/__pack/lookup/') ||
        url.startsWith('/__import/') ||
        url.startsWith(DEV_PACK_PREFIX);
      if (requiresRuntimeScope && scopedBinding === undefined) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'global-runtime-scope-route-disabled' }));
        return;
      }

      if (url === '/__pack/index' || url === '/pack-index.json') {
        // Wait for state.catalog to be ready (short-circuit if already built).
        if (!state.catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (state.catalogReady) {
                clearInterval(interval);
                resolve();
              }
            }, 5);
          });
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(callbacks.legacyCatalogResponse()));
        return;
      }

      const lookupPrefix = '/__pack/lookup/';
      if (url.startsWith(lookupPrefix)) {
        if (!state.catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (state.catalogReady) {
                clearInterval(interval);
                resolve();
              }
            }, 5);
          });
        }
        const guid = url.slice(lookupPrefix.length);
        const entry = state.catalog.find((e) => e.guid.toLowerCase() === guid.toLowerCase());
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
      // source directory, upgrades the state.catalog, and returns the updated
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
        if (!state.catalogReady) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (state.catalogReady) {
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
        if (
          state.guidToMeta.get(guidLower) === undefined &&
          state.importedRows.get(guidLower) === undefined
        ) {
          // A sidecar can be written immediately before this request, before
          // the debounced watcher flushes its state.catalog/index update. Refresh
          // the lightweight GUID index once so the import endpoint remains
          // race-free for just-written authoring sources.
          state.guidToMeta = await buildGuidToMetaMap(roots);
          const refreshedProjection = await buildCatalogProjection(
            roots,
            opts.base,
            registeredImporterKeys,
          );
          callbacks.installCatalogProjection({
            ...refreshedProjection,
            entries: await callbacks.publishAuthoredDevPacks(refreshedProjection.entries),
          });
          state.urlToAbs = buildUrlToAbsolute(state.catalog, {
            cwd: process.cwd(),
            ddcPath: (guid) => callbacks.ddcPath(process.cwd(), guid),
          });
        }
        if (
          state.guidToMeta.get(guidLower) === undefined &&
          state.importedRows.get(guidLower) === undefined
        ) {
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
        // Promise via state.inFlightMetaImports. The per-asset path below
        // (importOneTexture + state.inFlightImports) handles image sidecars where a
        // single GUID maps to a single texture asset.
        //
        // Dispatch: if the GUID belongs to an already-imported row (per-asset
        // path), return it immediately. Otherwise route through per-meta for
        // gltf sidecars, per-asset for everything else.
        const alreadyImported = state.importedRows.get(guidLower);
        if (alreadyImported !== undefined) {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify(
              scopedBinding === undefined
                ? [alreadyImported]
                : [
                    {
                      ...alreadyImported,
                      packageUrl: scopedPackageUrl(scopedBinding, alreadyImported.packageUrl),
                    },
                  ],
            ),
          );
          return;
        }

        const metaPath = state.guidToMeta.get(guidLower);
        let resultEntries: PackIndexEntry[];

        // Route registered non-image importers through the per-meta runner.
        // gltf / fbx / ui are engine products with explicit multi-asset
        // handling, while a registered host importer has the same contract:
        // one source + meta sidecar produces a DDC pack that cannot be
        // reconstructed by the texture-only path. The registry is the SSOT
        // for whether a host importer is wired; an unregistered key still
        // falls through to the raw-source state.catalog behavior. `image` remains
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
                registeredImporterKeys.has(metaRaw.importer));
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
            resultEntries = await ensureMetaImport(metaPath);
            // Filter to the requested GUID's row.
            const requested = resultEntries.find((e) => e.guid.toLowerCase() === guidLower);
            resultEntries = requested !== undefined ? [requested] : [];
          } else {
            // Fallback per-asset path (image sidecars, single-texture import).
            let inflight = state.inFlightImports.get(guidLower);
            if (inflight === undefined) {
              inflight = callbacks
                .importOneTexture(guidLower)
                .finally(() => state.inFlightImports.delete(guidLower));
              state.inFlightImports.set(guidLower, inflight);
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
        res.end(
          JSON.stringify(
            scopedBinding === undefined
              ? resultEntries
              : resultEntries.map((entry) => ({
                  ...entry,
                  packageUrl: scopedPackageUrl(scopedBinding, entry.packageUrl),
                })),
          ),
        );
        return;
      }

      // bug-20260610: serve in-memory `.pack.json` bodies produced by
      // `startMetaImport` for non-binary gltf sub-assets (mesh / scene /
      // material). The runtime's `fetchPackFile` GETs the state.catalog row's
      // `packageUrl`; without this route the request would fall through to
      // Vite's default 404 (or, worse, hit the raw `.gltf` URL when the row
      // was not rewritten and serve gltf JSON, which has no `assets[]`).
      const artifactBody = state.devArtifactBodies.get(url);
      if (artifactBody !== undefined) {
        res.statusCode = 200;
        res.setHeader('Content-Type', artifactBody.mimeType);
        res.end(artifactBody.bytes);
        return;
      }

      if (url.startsWith(DEV_PACK_PREFIX)) {
        let body: string | undefined;
        try {
          body = await callbacks.ensureMetaPackBody(url);
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
      // cannot find under the app root.  The state.catalog's `packageUrl`
      // paths are normalized (no `..` segments); the `state.urlToAbs` map
      // resolves each URL to its absolute source path.
      const absPath = state.urlToAbs.get(url);
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
  };

  const rebind = async (
    binding: RuntimeAssetBinding,
    nextRoots: readonly string[],
  ): Promise<RuntimeAssetBinding> => {
    const server = configuredServer;
    if (!configured || server === undefined) {
      throw new Error('forgeax:pack rebind requires configureServer first');
    }
    await startupReady;
    stopWatcher();
    resetState();
    runtimeToken = runtimeRealm.beginBind(binding, nextRoots);
    configureServer(server, nextRoots);
    await startupReady;
    return runtimeRealm.snapshot()?.binding ?? binding;
  };

  const runtimeBinding = (): RuntimeAssetBinding | undefined => runtimeRealm.snapshot()?.binding;

  const close = (): void => {
    stopWatcher();
    configured = false;
    runtimeRealm.clear();
  };

  return { configureServer, rebind, runtimeBinding, close } satisfies PluginServerLifecycle;
}
