// apps/preview -- minimal Vite host for loading bootstrap entry templates.
//
// Three-statement bootstrap (charter F1 limited context + P1 progressive disclosure):
//   1. createApp(canvas) -- one-shot engine wiring
//   2. loadGame(slug, resolver) -- resolve + validate the template module
//   3. await entry.bootstrap(world, ctx); app.start() -- run the game
//
// The resolver is a dynamic import proxy injected by the host so loadGame
// remains independent of Vite / bundler specifics. The slug defaults to
// `game-default` and may be overridden via `?game=<slug>`.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  type App,
  type BootstrapContext,
  type BootstrapEntry,
  type CanvasAppError,
  createApp,
  isAppError,
  isLoadGameError,
  loadGame,
} from '@forgeax/engine-app';
import { audioPlugin } from '@forgeax/engine-audio';
import type { SimulationError } from '@forgeax/engine-ecs';
import { physicsPlugin } from '@forgeax/engine-physics';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import {
  type CatalogEntry,
  createStandaloneRuntimeAssetBinding,
  ImportError,
} from '@forgeax/engine-types';
import { createUiLoader, type UiAsset, type UiError } from '@forgeax/engine-ui';
import { consumeSimulationError, createPreviewInspection } from './preview-inspection';
import { PREVIEW_UI_SOURCE_GUID, type UiAuthoringAssetGateway } from './ui-authoring';
import { createPreviewUiRun, type PreviewUiRun, reportPreviewEngineFailure } from './ui-root';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('preview: missing <canvas id="app"> in index.html');

const runtimeBinding = import.meta.env.DEV
  ? createStandaloneRuntimeAssetBinding(import.meta.env.FORGEAX_RUNTIME_SCOPE_ID ?? 'preview')
  : undefined;

const previewRun = createPreviewUiRun(canvas.parentElement ?? document.body);

// Wire dev-mode ImportTransport so loadByGuid for raw-source assets in
// templates/<slug>/scene.pack.json (and the engine-assets submodule's
// sky.hdr) lazy-imports via the binding's scoped import endpoint. The shipped
// form deliberately leaves this transport absent and reads the emitted
// /pack-index.json, so a missing DDC artefact fails fast instead of probing a
// dev-only route.
const app = await createApp(
  canvas,
  { uiRoot: previewRun.uiRoot, plugins: [audioPlugin(), physicsPlugin('rapier-3d')] },
  {
    ...forgeaxBundlerAdapter(),
    ...(runtimeBinding === undefined
      ? {}
      : { importTransport: createDevImportTransport(runtimeBinding) }),
  },
);
if (!app.ok) {
  if (runtimeBinding !== undefined) {
    try {
      previewRun.authoring.bind(
        await createPreviewUiCatalogGateway(runtimeBinding, import.meta.hot),
      );
    } catch (cause) {
      console.warn('[preview] UI catalog gateway unavailable:', cause);
    }
  }
  const diagnostic = reportCreateError(app.error);
  reportPreviewEngineFailure(previewRun, diagnostic);
} else {
  await startPreview(app.value, previewRun);
}

async function startPreview(app: App, previewRun: PreviewUiRun): Promise<void> {
  const assets = app.renderer.assets;
  if (runtimeBinding === undefined) assets.configurePackIndex('/pack-index.json');
  else assets.configureRuntimeBinding(runtimeBinding);
  await assets.refreshCatalog();
  previewRun.authoring.bind(createPreviewUiAssetGateway(assets, runtimeBinding, import.meta.hot));
  const previewInspection = createPreviewInspection(app, previewRun.registerCleanup);

  const ctx: BootstrapContext = {
    assets,
    app,
    renderer: app.renderer,
    // M2 D-9: wire the pointer-lock gate setter. The game template calls
    // setPointerLockAllowed(mode === 'fps') when switching modes; the
    // preview host delegates to the input backend's setPointerLockAllowed.
    // No lockProvider is injected — Web host goes W3C path.
    setPointerLockAllowed: (allowed: boolean) => app.input?.setPointerLockAllowed?.(allowed),
    uiRoot: previewRun.uiRoot,
    registerCleanup: previewRun.registerCleanup,
    gameProjection: previewInspection.registrar,
  };

  const slug = new URLSearchParams(window.location.search).get('game') ?? 'game-default';

  const templateModules = import.meta.glob<{ bootstrap: () => unknown }>(
    '../../../templates/*/main.ts',
  );

  const loaded = await loadGame(slug, (s) => {
    const key = `../../../templates/${s}/main.ts`;
    const loader = templateModules[key];
    if (!loader) return Promise.reject(new Error(`Unknown template: ${s}`));
    return loader();
  });
  if (!loaded.ok) {
    previewRun.cleanup();
    reportLoadError(loaded.error);
    throw new Error('preview: loadGame failed');
  }

  const entry: BootstrapEntry = loaded.value;
  try {
    await entry(app.world, ctx);
  } catch (e: unknown) {
    previewRun.cleanup();
    console.error('[preview] bootstrap rejected:', e);
    throw e;
  }
  app.start();

  // Graceful GPU shutdown: dispose before reload. Without this, rapid reloads
  // leak GPU contexts -> STATUS_ACCESS_VIOLATION.
  let disposed = false;
  const reportedAppErrorCodes = new Set<string>();
  const gracefulDispose = (): void => {
    if (disposed) return;
    disposed = true;
    app.stop();
    app.renderer.dispose();
    previewRun.cleanup();
  };
  window.addEventListener('message', (ev) => {
    if ((ev.data as { type?: string } | null)?.type === 'VAG_PREVIEW_DISPOSE') {
      gracefulDispose();
    }
  });
  window.addEventListener('pagehide', gracefulDispose);
  app.onError((err: { code?: string }) => {
    const code = err.code ?? 'unknown';
    if (!reportedAppErrorCodes.has(code)) {
      reportedAppErrorCodes.add(code);
      console.error(`[preview] app error: ${JSON.stringify(err)}`);
    }
    if (err.code === 'device-lost') {
      window.parent?.postMessage({ type: 'VAG_DEVICE_LOST' }, '*');
    }
  });
}

function createPreviewUiAssetGateway(
  assets: App['renderer']['assets'],
  binding: typeof runtimeBinding,
  hot: ImportMeta['hot'],
): UiAuthoringAssetGateway {
  return {
    preferredGuid: '019f8354-6386-4386-849d-f2ab4b96229d',
    listCatalog: () =>
      assets
        .listCatalog()
        .filter((entry) => entry.kind === 'ui')
        .map((entry) => ({
          guid: entry.guid,
          kind: 'ui' as const,
          ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
        })),
    async loadByGuid(guid) {
      let parsed: ReturnType<typeof assets.parseGuid>;
      try {
        parsed = assets.parseGuid(guid);
      } catch (cause) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: 'a valid UI asset GUID',
            hint: 'Discover a catalogued UI GUID before loading it.',
            detail: { reason: cause instanceof Error ? cause.message : String(cause) },
          }),
        };
      }
      const loaded = await assets.loadByGuid<UiAsset>(parsed);
      if (loaded.ok) return loaded;
      const imported = await readPreviewImportFailure(guid, binding);
      return {
        ok: false,
        error:
          imported ??
          new ImportError({
            code: 'import-internal-error',
            expected: 'the catalogued UI asset to load through the runtime registry',
            hint: 'Inspect the asset loading error and retry after repairing the source.',
            detail: { reason: loaded.error.code },
          }),
      };
    },
    invalidate: (guid) => assets.invalidate(guid),
    replace: async (asset) => ({ ok: true, value: asset }),
    subscribe(listener) {
      if (hot === undefined) return () => {};
      const onAssetChanged = (data: unknown): void => {
        if (typeof data !== 'object' || data === null) return;
        const payload = data as {
          guids?: unknown;
          sourcePath?: unknown;
          revision?: unknown;
        };
        if (
          !Array.isArray(payload.guids) ||
          !payload.guids.every((guid) => typeof guid === 'string')
        )
          return;
        listener({
          guids: payload.guids,
          sourcePath: typeof payload.sourcePath === 'string' ? payload.sourcePath : 'ui source',
          revision: typeof payload.revision === 'number' ? payload.revision : Date.now(),
        });
      };
      hot.on('forgeax:asset-changed', onAssetChanged);
      return () => hot.off('forgeax:asset-changed', onAssetChanged);
    },
  };
}

async function createPreviewUiCatalogGateway(
  binding: NonNullable<typeof runtimeBinding>,
  hot: ImportMeta['hot'],
): Promise<UiAuthoringAssetGateway> {
  let entries = await fetchCatalogEntries(binding.catalogUrl);
  const loader = createUiLoader();
  const refresh = async (): Promise<void> => {
    entries = await fetchCatalogEntries(binding.catalogUrl);
  };
  const importSource = async (guid: string): Promise<ImportError | undefined> => {
    const response = await fetch(`${binding.importUrlBase}/${encodeURIComponent(guid)}`, {
      method: 'POST',
    });
    if (response.ok) return undefined;
    return importErrorFromResponse(await readJsonResponse(response));
  };
  const findEntry = (guid: string): CatalogEntry | undefined =>
    entries.find((entry) => entry.guid.toLowerCase() === guid.toLowerCase());

  return {
    preferredGuid: PREVIEW_UI_SOURCE_GUID,
    listCatalog: () =>
      entries
        .filter((entry) => entry.kind === 'ui')
        .map((entry) => ({ guid: entry.guid, kind: 'ui' as const, sourcePath: entry.sourcePath })),
    async loadByGuid(guid) {
      let entry = findEntry(guid);
      if (entry === undefined) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: 'a catalogued UI asset GUID',
            hint: 'Discover a valid UI GUID before opening preview.',
            detail: { reason: `Unknown UI GUID: ${guid}` },
          }),
        };
      }
      let response = await fetch(entry.packageUrl);
      if (!response.ok) {
        const imported = await importSource(guid);
        if (imported !== undefined) return { ok: false, error: imported };
        await refresh();
        entry = findEntry(guid);
        if (entry === undefined) {
          return {
            ok: false,
            error: new ImportError({
              code: 'import-internal-error',
              expected: 'the imported UI GUID to remain in the catalog',
              hint: 'Refresh the catalog and retry the preview.',
              detail: { reason: `Imported UI GUID disappeared: ${guid}` },
            }),
          };
        }
        response = await fetch(entry.packageUrl);
      }
      if (!response.ok) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: 'the catalogued UI pack to be readable',
            hint: 'Inspect the package URL and retry after importing the source.',
            detail: { reason: `HTTP ${response.status} for ${entry.packageUrl}` },
          }),
        };
      }
      const body = (await response.json()) as { assets?: readonly unknown[] };
      const packed = body.assets?.find(
        (asset): asset is { readonly guid: string } =>
          typeof asset === 'object' &&
          asset !== null &&
          typeof (asset as { guid?: unknown }).guid === 'string' &&
          (asset as { guid: string }).guid.toLowerCase() === guid.toLowerCase(),
      );
      if (packed === undefined) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: 'a UI asset envelope in the catalogued pack',
            hint: 'Re-import the source and retry the preview.',
            detail: { reason: `Pack has no UI asset ${guid}` },
          }),
        };
      }
      const loaded = loader.load(packed);
      if (loaded.ok) return loaded;
      return { ok: false, error: importErrorFromUiError(loaded.error) };
    },
    invalidate: () => {},
    replace: async (asset) => ({ ok: true, value: asset }),
    subscribe(listener) {
      if (hot === undefined) return () => {};
      const onAssetChanged = (data: unknown): void => {
        if (typeof data !== 'object' || data === null) return;
        const payload = data as { guids?: unknown; sourcePath?: unknown; revision?: unknown };
        if (
          !Array.isArray(payload.guids) ||
          !payload.guids.every((guid) => typeof guid === 'string')
        )
          return;
        listener({
          guids: payload.guids,
          sourcePath: typeof payload.sourcePath === 'string' ? payload.sourcePath : 'ui source',
          revision: typeof payload.revision === 'number' ? payload.revision : Date.now(),
        });
      };
      hot.on('forgeax:asset-changed', onAssetChanged);
      return () => hot.off('forgeax:asset-changed', onAssetChanged);
    },
  };
}

async function fetchCatalogEntries(url: string): Promise<CatalogEntry[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`);
  const body = (await response.json()) as { entries?: unknown } | unknown;
  const entries =
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { entries?: unknown }).entries)
      ? (body as { entries: unknown[] }).entries
      : Array.isArray(body)
        ? body
        : undefined;
  if (entries === undefined) throw new Error('catalog response has no entries array');
  return entries.filter(isCatalogEntry);
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { guid?: unknown }).guid === 'string' &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { packageUrl?: unknown }).packageUrl === 'string' &&
    typeof (value as { sourcePath?: unknown }).sourcePath === 'string'
  );
}

async function readJsonResponse(response: Response): Promise<{
  readonly code?: unknown;
  readonly detail?: unknown;
  readonly hint?: unknown;
}> {
  try {
    return (await response.json()) as {
      readonly code?: unknown;
      readonly detail?: unknown;
      readonly hint?: unknown;
    };
  } catch {
    return {};
  }
}

function importErrorFromResponse(body: {
  readonly code?: unknown;
  readonly detail?: unknown;
  readonly hint?: unknown;
}): ImportError {
  if (body.code === 'source-validation-failed' && isDiagnostics(body.detail)) {
    return new ImportError({
      code: 'source-validation-failed',
      expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
      hint: typeof body.hint === 'string' ? body.hint : 'Repair the UI source and retry.',
      detail: { diagnostics: body.detail.diagnostics },
    });
  }
  return new ImportError({
    code: 'import-internal-error',
    expected: 'the UI importer to produce a Pack v2 asset',
    hint: typeof body.hint === 'string' ? body.hint : 'Repair the UI source and retry.',
    detail: { reason: typeof body.code === 'string' ? body.code : 'import-failed' },
  });
}

function importErrorFromUiError(error: UiError): ImportError {
  return new ImportError({
    code: 'import-internal-error',
    expected: 'the UI loader to accept the imported asset envelope',
    hint: 'Re-import the source and retry the preview.',
    detail: { reason: error.detail.message },
  });
}

async function readPreviewImportFailure(
  guid: string,
  binding: typeof runtimeBinding,
): Promise<ImportError | undefined> {
  if (binding === undefined) return undefined;
  try {
    const response = await fetch(`${binding.importUrlBase}/${encodeURIComponent(guid)}`, {
      method: 'POST',
    });
    if (response.ok) return undefined;
    return importErrorFromResponse(await readJsonResponse(response));
  } catch {
    return undefined;
  }
}

function isDiagnostics(value: unknown): value is {
  readonly diagnostics: readonly import('@forgeax/engine-types').ImportDiagnostic[];
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { diagnostics?: unknown }).diagnostics)
  );
}

function reportCreateError(err: CanvasAppError): {
  readonly code: string;
  readonly detail: string;
} {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[preview] EngineEnvironmentError: webgpu inner=${code}`);
    return { code: 'engine-environment', detail: `webgpu inner=${code}` };
  }
  if (isSimulationError(err)) {
    const surface = consumeSimulationError(err, 'unavailable-before-app-world');
    console.error(`[preview] SimulationError ${surface.code}: ${surface.hint}`);
    return { code: surface.code, detail: surface.hint };
  }
  if (isAppError(err)) {
    switch (err.code) {
      case 'app-not-started':
      case 'app-already-running':
      case 'app-canvas-detached':
      case 'app-system-update-failed':
      case 'app-pointer-lock-failed':
        console.error(`[preview] AppError ${err.code}: ${err.hint}`);
        return { code: err.code, detail: err.hint };
    }
  } else {
    switch (err.code) {
      case 'adapter-unavailable':
      case 'feature-not-enabled':
      case 'limit-exceeded':
      case 'shader-compile-failed':
      case 'rhi-not-available':
      case 'webgpu-runtime-error':
      case 'command-encoder-finished':
      case 'render-pass-not-ended':
      case 'queue-submit-failed':
      case 'queue-write-buffer-out-of-bounds':
      case 'render-system-no-camera':
      case 'render-system-multi-camera':
      case 'render-system-multi-light':
      case 'asset-not-registered':
      case 'device-lost':
      case 'oom':
      case 'internal-error':
      case 'hierarchy-broken':
      case 'destroy-after-destroy':
        console.error(`[preview] RhiError ${err.code}: ${err.hint}`);
        return { code: err.code, detail: err.hint };
    }
  }
  return { code: 'unknown', detail: String(err) };
}

function isSimulationError(err: CanvasAppError): err is SimulationError {
  return 'code' in err && typeof err.code === 'string' && err.code.startsWith('simulation-');
}

function reportLoadError(err: unknown): void {
  if (!isLoadGameError(err)) {
    console.error('[preview] unknown load error:', err);
    return;
  }
  switch (err.code) {
    case 'module-not-found':
      console.error(`[preview] load failed, module not found: ${err.detail.slug}`);
      return;
    case 'invalid-format':
      console.error(
        `[preview] load failed, invalid format. Exports: ${err.detail.exportKeys.join(', ')}`,
      );
      return;
    case 'import-failed':
      console.error('[preview] load failed, import error:', err.detail.cause);
      return;
  }
}
