import { normalizeSourcePackageError, type SourcePackageError } from '@forgeax/engine-import';
import { catalogProjectionFor, metaPathForGuid } from '@forgeax/engine-pack/build';
import type { CatalogDiagnostic, PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { DevSession } from './dev-session.js';
import type { DispatcherHandler, DispatcherResponse } from './dispatcher.js';
import type { PluginServerRouteCallbacks, PluginServerState } from './plugin-server.js';
import { readRequestHeader } from './request-header.js';

export interface TransportRouteContext {
  readonly startupReady: Promise<void>;
  readonly transportBase?: string | undefined;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerRouteCallbacks;
  readonly devSession: DevSession | undefined;
  readonly scopedPackageUrl: (binding: RuntimeAssetBinding, packageUrl: string) => string;
  readonly scopedCatalogResponse: (binding: RuntimeAssetBinding) => unknown;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function transportBasePrefix(base: string | undefined): string {
  const normalized = (base ?? '').replace(/^\/+|\/+$/g, '');
  return normalized.length === 0 ? '' : `/${normalized}`;
}

function normalizeTransportUrl(url: string, base: string | undefined): string {
  const prefix = transportBasePrefix(base);
  if (prefix.length === 0) return url;
  if (url === prefix) return '/';
  return url.startsWith(`${prefix}/`) ? url.slice(prefix.length) || '/' : url;
}

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

export function createTransportRouteHandler(context: TransportRouteContext): DispatcherHandler {
  return (req, res, next) => handleTransportRequest(context, req, res, next);
}

interface ResolvedScopeRoute {
  readonly handled: boolean;
  readonly url: string;
  readonly scopedBinding?: RuntimeAssetBinding;
}

function sendJson(res: DispatcherResponse, body: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function catalogDiagnosticForSourcePackageError(error: SourcePackageError): CatalogDiagnostic {
  const affected = new Set(error.detail.affectedGuids.map((guid) => guid.toLowerCase()));
  return {
    code: error.code,
    severity: 'blocking',
    authority: 'producer',
    expected: error.expected,
    ...(error.detail.reason === undefined ? {} : { actual: error.detail.reason }),
    hint: error.hint,
    evidence: [...affected].map((guid) => ({ type: 'asset', id: guid })),
    recoveryIntents: [error.hint],
  };
}

export function projectSourcePackageFailure(
  rows: readonly PackIndexEntry[],
  error: SourcePackageError,
): PackIndexEntry[] {
  const affected = new Set(error.detail.affectedGuids.map((guid) => guid.toLowerCase()));
  const diagnostic = catalogDiagnosticForSourcePackageError(error);
  return rows.map((row) => {
    if (!affected.has(row.guid.toLowerCase())) return row;
    const subject = row.subject ?? 'imported-output';
    const execution = row.execution ?? 'cooked';
    const projection = catalogProjectionFor(subject, execution, 'failed');
    const lastKnownGood = row.projection?.lastKnownGood;
    return {
      ...row,
      lifecycle: projection.lifecycle,
      diagnostics: [...(row.diagnostics ?? []), diagnostic],
      projection: {
        ...projection,
        ...(lastKnownGood === undefined ? {} : { lastKnownGood }),
      },
    };
  });
}

function gateSession(context: TransportRouteContext, res: DispatcherResponse): boolean {
  const sessionState = context.devSession?.state();
  if (sessionState === undefined || sessionState.status === 'starting') {
    sendJson(
      res,
      {
        error: 'pack-session-starting',
        expected: 'an accepted ForgeaX pack snapshot',
        hint: 'wait for startup, then enumerate and retry',
      },
      503,
    );
    return false;
  }
  if (sessionState.status === 'closing' || sessionState.status === 'closed') {
    sendJson(
      res,
      {
        error: 'pack-session-closed',
        expected: 'an open ForgeaX pack session',
        hint: 'create a new Vite server session before retrying',
      },
      410,
    );
    return false;
  }
  if (sessionState.status === 'failed') {
    const sessionFailure = sessionState.error;
    sendJson(
      res,
      {
        error: sessionFailure?.code ?? 'scan-failed',
        expected: sessionFailure?.expected ?? 'an accepted ForgeaX pack snapshot',
        hint: sessionFailure?.hint ?? 'repair the producer, rebuild, verify, and retry',
        ...(sessionFailure === undefined ? {} : { detail: sessionFailure.detail }),
      },
      503,
    );
    return false;
  }
  return true;
}

async function resolveScopedRoute(
  context: TransportRouteContext,
  url: string,
  res: DispatcherResponse,
): Promise<ResolvedScopeRoute> {
  const parsed = parseRuntimeScopeRoute(url);
  if (parsed === undefined) return { handled: false, url };

  const current = context.devSession?.runtimeScope();
  if (current === undefined) {
    sendJson(res, { error: 'runtime-scope-unbound' }, 404);
    return { handled: true, url };
  }
  if (current.scopeId !== parsed.scopeId) {
    sendJson(res, { error: 'runtime-scope-not-found', scopeId: parsed.scopeId }, 404);
    return { handled: true, url };
  }
  if (current.generation !== parsed.generation) {
    sendJson(
      res,
      {
        error: 'runtime-scope-generation-expired',
        scopeId: parsed.scopeId,
        generation: parsed.generation,
        currentGeneration: current.generation,
      },
      410,
    );
    return { handled: true, url };
  }

  await context.startupReady;
  if (!gateSession(context, res)) return { handled: true, url };
  const latest = context.devSession?.runtimeScope();
  if (latest === undefined || latest.generation !== parsed.generation) {
    sendJson(res, { error: 'runtime-scope-generation-expired' }, 410);
    return { handled: true, url };
  }
  if (latest.status === 'transitioning' || latest.status === 'unavailable') {
    sendJson(res, { error: 'runtime-scope-unavailable', status: latest.status }, 503);
    return { handled: true, url };
  }
  if (parsed.suffix === '/catalog.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(context.scopedCatalogResponse(latest)));
    return { handled: true, url };
  }
  if (latest.status === 'degraded' || latest.authority === 'degraded') {
    sendJson(
      res,
      { error: 'runtime-scope-catalog-degraded', diagnostics: latest.diagnostics ?? [] },
      409,
    );
    return { handled: true, url };
  }
  if (parsed.suffix.startsWith('/import/')) {
    const guid = parsed.suffix.slice('/import/'.length);
    if (guid.length === 0 || guid.includes('/')) {
      res.statusCode = 404;
      res.end('');
      return { handled: true, url };
    }
    return { handled: false, url: `/__import/${guid}`, scopedBinding: latest };
  }
  if (parsed.suffix.startsWith('/asset/')) {
    return { handled: false, url: parsed.suffix.slice('/asset'.length), scopedBinding: latest };
  }
  sendJson(res, { error: 'runtime-scope-route-not-found' }, 404);
  return { handled: true, url };
}

function scopedEntry(
  context: TransportRouteContext,
  binding: RuntimeAssetBinding | undefined,
  entry: PackIndexEntry,
): PackIndexEntry {
  return binding === undefined
    ? entry
    : { ...entry, packageUrl: context.scopedPackageUrl(binding, entry.packageUrl) };
}

async function handleGenericImport(
  context: TransportRouteContext,
  guid: string,
  rebuildRequested: boolean,
  scopedBinding: RuntimeAssetBinding | undefined,
  res: DispatcherResponse,
  catalogSourceKey?: string,
): Promise<boolean> {
  let resultEntries: readonly PackIndexEntry[];
  try {
    resultEntries =
      (await (rebuildRequested
        ? context.callbacks.rebuildAsset?.(
          guid,
          undefined,
          catalogSourceKey === undefined ? undefined : { sourceKeys: [catalogSourceKey] },
        )
        : context.callbacks.materializeAsset?.(guid))) ?? [];
    if (!gateSession(context, res)) return true;
  } catch (error) {
    if (!gateSession(context, res)) return true;
    const catalog = context.state.catalogProjection.entries;
    const row = catalog.find((entry) => entry.guid.toLowerCase() === guid);
    if (row?.sourcePath.endsWith('.pack.ts')) {
      const normalized = normalizeSourcePackageError(error, {
        sourceMeta: row.sourcePath,
        anchorGuid: row.guid,
        affectedGuids: [row.guid],
        producer: row.provenance?.provider ?? 'source-package',
        importer: row.provenance?.provider ?? 'source-package',
      });
      context.state.catalogProjection = {
        ...context.state.catalogProjection,
        entries: projectSourcePackageFailure(catalog, normalized),
      };
      sendJson(
        res,
        {
          error: 'source-package-failed',
          guid,
          code: normalized.code,
          expected: normalized.expected,
          hint: normalized.hint,
          detail: normalized.detail,
        },
        422,
      );
      return true;
    }
    const detail =
      typeof error === 'object' && error !== null && 'detail' in error
        ? (error as { detail?: unknown }).detail
        : { reason: error instanceof Error ? error.message : String(error) };
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'import-internal-error';
    const hint =
      typeof error === 'object' && error !== null && 'hint' in error
        ? String((error as { hint: unknown }).hint)
        : 'importer threw while converting the source';
    sendJson(res, { error: 'import-failed', guid, code, detail, hint }, 422);
    return true;
  }
  if (resultEntries.length === 0) {
    sendJson(res, { error: 'import-failed', guid, hint: 'producer closure omitted the GUID' }, 422);
    return true;
  }
  sendJson(
    res,
    resultEntries.map((entry) => scopedEntry(context, scopedBinding, entry)),
  );
  return true;
}

async function handleImportRoute(
  context: TransportRouteContext,
  req: Parameters<DispatcherHandler>[0],
  url: string,
  scopedBinding: RuntimeAssetBinding | undefined,
  res: DispatcherResponse,
): Promise<boolean> {
  const importPrefix = '/__import/';
  if (!url.startsWith(importPrefix)) return false;
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    sendJson(res, { error: 'method-not-allowed', hint: 'use POST to trigger lazy import' }, 405);
    return true;
  }
  const guidWithQuery = url.slice(importPrefix.length);
  const queryIndex = guidWithQuery.indexOf('?');
  const guid = queryIndex >= 0 ? guidWithQuery.slice(0, queryIndex) : guidWithQuery;
  const guidLower = guid.toLowerCase();
  const reqHeaders = (
    req as {
      headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
    }
  ).headers;
  const headerMode = readRequestHeader(reqHeaders, 'x-forgeax-import-mode');
  const queryMode = queryIndex >= 0
    ? new URLSearchParams(guidWithQuery.slice(queryIndex)).get('import-mode') ?? undefined
    : undefined;
  const importMode = headerMode ?? queryMode;
  // Fresh sidecar writes are not yet indexed — POST import rebuilds by default.
  const rebuildRequested = importMode !== 'cold-cook';
  const guidDeclared =
    metaPathForGuid(context.state.catalogProjection.declarations, guidLower) !== undefined
    || context.state.importedGuids.has(guidLower)
    || context.state.catalogProjection.entries.some((entry) => entry.guid.toLowerCase() === guidLower);
  // Fresh sidecar writes land on disk before the watcher/index projects the GUID.
  // Rebuild mode rescans roots and materializes the meta package — do not 404 early.
  if (!rebuildRequested && !guidDeclared) {
    sendJson(res, { error: 'meta-not-found', guid, hint: 'no source declares this GUID' }, 404);
    return true;
  }
  const alreadyImported = context.state.importedGuids.has(guidLower)
    ? context.state.catalogProjection.entries.find(
        (entry) => entry.guid.toLowerCase() === guidLower,
      )
    : undefined;
  if (alreadyImported !== undefined && !rebuildRequested) {
    sendJson(res, [scopedEntry(context, scopedBinding, alreadyImported)]);
    return true;
  }
  const catalogSourceKeyRaw = readRequestHeader(reqHeaders, 'x-forgeax-import-source-key');
  const catalogSourceKey = catalogSourceKeyRaw !== undefined && catalogSourceKeyRaw.length > 0
    ? catalogSourceKeyRaw
    : undefined;
  return handleGenericImport(context, guidLower, rebuildRequested, scopedBinding, res, catalogSourceKey);
}

function handleScopedLookupRoute(
  context: TransportRouteContext,
  url: string,
  scopedBinding: RuntimeAssetBinding | undefined,
  res: DispatcherResponse,
): boolean {
  if (scopedBinding === undefined || !url.startsWith('/__pack/lookup/')) return false;
  const guid = url.slice('/__pack/lookup/'.length);
  const entry = context.state.catalogProjection.entries.find(
    (candidate) => candidate.guid.toLowerCase() === guid.toLowerCase(),
  );
  if (entry === undefined) {
    sendJson(res, { error: 'not-found', guid }, 404);
    return true;
  }
  sendJson(res, scopedEntry(context, scopedBinding, entry));
  return true;
}

async function handlePackRoute(
  context: TransportRouteContext,
  url: string,
  res: DispatcherResponse,
): Promise<boolean> {
  const artifactBody = context.state.devArtifactBodies.get(url);
  if (artifactBody !== undefined) {
    res.statusCode = 200;
    res.setHeader('Content-Type', artifactBody.mimeType);
    res.end(artifactBody.bytes);
    return true;
  }
  const authoredPack = context.state.catalogProjection.entries.some(
    (entry) => entry.packageUrl === url && entry.sourcePath.endsWith('.pack.json'),
  );
  if (!url.startsWith(DEV_PACK_PREFIX) && !authoredPack) return false;
  let body: string | undefined;
  try {
    body = await context.callbacks.ensureMetaPackBody(url);
    if (!gateSession(context, res)) return true;
  } catch (error) {
    if (!gateSession(context, res)) return true;
    const failure =
      error !== null && typeof error === 'object'
        ? error
        : { hint: error instanceof Error ? error.message : String(error) };
    sendJson(
      res,
      {
        ...failure,
        error: 'pack-cook-failed',
        url,
      },
      422,
    );
    return true;
  }
  if (body === undefined) {
    sendJson(
      res,
      { error: 'pack-body-not-found', url, hint: 'no producer output exists for this URL' },
      404,
    );
    return true;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
  return true;
}

async function handleTransportRequest(
  context: TransportRouteContext,
  req: Parameters<DispatcherHandler>[0],
  res: DispatcherResponse,
  next: Parameters<DispatcherHandler>[2],
): Promise<void> {
  const normalizedUrl = normalizeTransportUrl(req.url ?? '', context.transportBase);
  const resolved = await resolveScopedRoute(context, normalizedUrl, res);
  if (resolved.handled) return;
  const { url, scopedBinding } = resolved;
  const requiresRuntimeScope =
    url === '/__pack/index' ||
    url === '/pack-index.json' ||
    url.startsWith('/__pack/lookup/') ||
    url.startsWith('/__import/') ||
    url.startsWith(DEV_PACK_PREFIX);
  if (requiresRuntimeScope) {
    if (scopedBinding === undefined && context.devSession?.runtimeScope() === undefined) {
      await context.startupReady;
    }
    if (!gateSession(context, res)) return;
  }
  if (requiresRuntimeScope && scopedBinding === undefined) {
    sendJson(res, { error: 'global-runtime-scope-route-disabled' }, 404);
    return;
  }
  if (handleScopedLookupRoute(context, url, scopedBinding, res)) return;
  if (await handleImportRoute(context, req, url, scopedBinding, res)) return;
  if (await handlePackRoute(context, url, res)) return;
  next();
}
