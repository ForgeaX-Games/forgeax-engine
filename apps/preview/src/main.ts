// apps/preview -- Vite host for asset-resident Cordis game plugins.
//
// Three-statement composition:
//   1. createApp(canvas) -- one-shot engine wiring
//   2. loadGame(slug, resolver) -- resolve + validate the template module
//   3. provide GameHost, mount gameplay, then start the App
//
// The resolver is a dynamic import proxy injected by the host so loadGame
// remains independent of Vite / bundler specifics. The slug defaults to
// `game-default` and may be overridden via `?game=<slug>`.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import {
  type App,
  type CanvasAppError,
  createApp,
  type GameHost,
  gameHostPlugin,
  isAppError,
  isLoadGameError,
  loadGame,
} from '@forgeax/engine-app';
import { audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { physicsPlugin } from '@forgeax/engine-physics';
import { buildProfileModel, createProfiler } from '@forgeax/engine-profiler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { type CatalogEntry, ImportError, type SceneAsset } from '@forgeax/engine-types';
import { createUiLoader, type UiAsset, type UiError } from '@forgeax/engine-ui';
import { createPreviewInspection } from './preview-inspection';
import { PREVIEW_UI_SOURCE_GUID, type UiAuthoringAssetGateway } from './ui-authoring';
import { createPreviewUiRun, type PreviewUiRun, reportPreviewEngineFailure } from './ui-root';

const previewQuery = new URLSearchParams(window.location.search);
if (previewQuery.get('fixture') === 'gltf-transform') {
  document.body.dataset.previewFixture = 'gltf-transform';
}
const positiveQueryInt = (name: string, fallback: number): number => {
  const value = Number(previewQuery.get(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('preview: missing <canvas id="app"> in index.html');
const previewCanvas = canvas;

// Pack owns the Preview realm identity; this shared projection is used for
// both the scoped development transport and production publication tuples.
const runtimeDevBinding = import.meta.env.DEV ? runtimeBinding : undefined;
const previewRun = createPreviewUiRun(previewCanvas.parentElement ?? document.body);
const previewProfiler = previewQuery.get('profile') === '1' ? createProfiler() : undefined;
const previewPlugins = [
  webAudioPlugin(),
  audioPlugin(),
  ...(previewQuery.get('profileNoPhysics') === '1' ? [] : [physicsPlugin('rapier-3d')]),
];

// Wire dev-mode ImportTransport so loadByGuid for raw-source assets in
// templates/<slug>/scene.pack.json (and the engine-assets submodule's
// sky.hdr) lazy-imports via the binding's scoped import endpoint. The shipped
// form deliberately leaves this transport absent and reads the emitted
// /pack-index.json, so a missing DDC artefact fails fast instead of probing a
// dev-only route.
const app = await createApp(
  previewCanvas,
  {
    uiRoot: previewRun.uiRoot,
    plugins: previewPlugins,
    ...(previewProfiler === undefined ? {} : { profiler: previewProfiler }),
  },
  {
    ...forgeaxBundlerAdapter(),
    ...(runtimeDevBinding === undefined
      ? {}
      : { importTransport: createRuntimeAssetImportTransport(runtimeDevBinding) }),
  },
);
if (!app.ok) {
  if (runtimeDevBinding !== undefined) {
    try {
      previewRun.authoring.bind(
        await createPreviewUiCatalogGateway(runtimeDevBinding, import.meta.hot),
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
  const assets = app.assets;
  if (assets === undefined) {
    previewRun.cleanup();
    throw new Error('preview: canvas App did not provide its AssetRegistry');
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  await assets.refreshCatalog();
  previewRun.authoring.bind(createPreviewUiAssetGateway(assets, runtimeBinding, import.meta.hot));
  const previewInspection = createPreviewInspection(app, previewRun.registerCleanup);

  const slug = new URLSearchParams(window.location.search).get('game') ?? 'game-default';

  const templateManifests = import.meta.glob<{ entry: string; defaultScene?: string }>(
    '../../../templates/*/forge.json',
    { eager: true, import: 'default' },
  );
  const templateModules = import.meta.glob<{ default: unknown }>([
    '../../../templates/*/main.ts',
    '../../../templates/*/src/main.ts',
  ]);

  const loaded = await loadGame(slug, (s) => {
    const manifest = templateManifests[`../../../templates/${s}/forge.json`];
    if (!manifest) return Promise.reject(new Error(`Unknown template: ${s}`));
    const key = `../../../templates/${s}/${manifest.entry.replace(/^\.\//, '')}`;
    const loader = templateModules[key];
    if (!loader) return Promise.reject(new Error(`Unknown template entry: ${s}/${manifest.entry}`));
    return loader();
  });
  if (!loaded.ok) {
    previewRun.cleanup();
    reportLoadError(loaded.error);
    throw new Error('preview: loadGame failed');
  }

  const manifest = templateManifests[`../../../templates/${slug}/forge.json`];
  if (manifest === undefined) throw new Error(`preview: missing loaded template manifest ${slug}`);
  let defaultScene: SceneAsset | undefined;
  let defaultSceneRoot: GameHost['defaultSceneRoot'];
  if (manifest.defaultScene !== undefined) {
    const scene = await assets.loadByGuid<SceneAsset>(assets.parseGuid(manifest.defaultScene));
    if (!scene.ok) throw scene.error;
    defaultScene = scene.value;
    const handle = app.world.allocSharedRef('SceneAsset', scene.value);
    const instantiated = assets.instantiate<SceneAsset>(handle, app.world);
    if (!instantiated.ok) throw instantiated.error;
    defaultSceneRoot = instantiated.value;
  }

  const ctx: GameHost = {
    canvas: previewCanvas,
    assets,
    app,
    renderer: app.renderer,
    ...(defaultScene === undefined ? {} : { defaultScene }),
    ...(defaultSceneRoot === undefined ? {} : { defaultSceneRoot }),
    // M2 D-9: wire the pointer-lock gate setter. The game template calls
    // setPointerLockAllowed(mode === 'fps') when switching modes; the
    // preview host delegates to the input backend's setPointerLockAllowed.
    // No lockProvider is injected — Web host goes W3C path.
    setPointerLockAllowed: (allowed: boolean) => app.input?.setPointerLockAllowed?.(allowed),
    uiRoot: previewRun.uiRoot,
    gameProjection: previewInspection.registrar,
  };

  try {
    await app.pluginContext.plugin(gameHostPlugin(ctx));
    await app.pluginContext.plugin(loaded.value);
  } catch (e: unknown) {
    previewRun.cleanup();
    console.error('[preview] gameplay activation rejected:', e);
    throw e;
  }
  app.start();

  if (previewProfiler !== undefined) {
    const started = previewProfiler.startCapture({
      frameLimit: positiveQueryInt('profileFrames', 3600),
      eventLimit: positiveQueryInt('profileEvents', 786432),
      detail: 'nested',
    });
    if (!started.ok) {
      console.warn(`[preview] profiler start failed: ${started.error.code}`);
    } else {
      const poll = window.setInterval(() => {
        const capture = previewProfiler.latestCapture();
        if (capture === undefined) return;
        window.clearInterval(poll);
        const model = buildProfileModel(capture);
        if (!model.ok) {
          console.warn(`[preview] profiler model failed: ${model.error.code}`);
          return;
        }
        const phases = [...model.value.phases]
          .sort((left, right) => (right.p95DurationMicros ?? -1) - (left.p95DurationMicros ?? -1))
          .slice(0, 12);
        const frameP95 = (
          frames: readonly { readonly durationMicros: number }[],
        ): number | null => {
          const values = frames
            .map((frame) => frame.durationMicros)
            .filter((value) => value > 0)
            .sort((a, b) => a - b);
          return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null;
        };
        const firstFrames = model.value.frames.slice(0, 60);
        const lastFrames = model.value.frames.slice(-60);
        const lastFrame = model.value.frames[model.value.frames.length - 1];
        // Keep the opt-in capture visible to the host's profiling smoke output.
        // Other preview diagnostics intentionally use warn/error, per repo lint policy.
        // biome-ignore lint/suspicious/noConsole: profiler capture is an explicit host diagnostic
        console.info(
          '[preview] profiler capture',
          JSON.stringify({
            summary: model.value.summary,
            hottestPhases: phases,
            frameP95: {
              first60Micros: frameP95(firstFrames),
              last60Micros: frameP95(lastFrames),
              driftMicros: (frameP95(lastFrames) ?? 0) - (frameP95(firstFrames) ?? 0),
            },
            lastFrame:
              lastFrame === undefined
                ? undefined
                : {
                    frameId: lastFrame.frameId,
                    durationMicros: lastFrame.durationMicros,
                    recordCount: lastFrame.recordCount,
                    phaseCount: lastFrame.phaseCount,
                  },
          }),
        );
      }, 100);
    }
  }

  // Graceful GPU shutdown: dispose before reload. Without this, rapid reloads
  // leak GPU contexts -> STATUS_ACCESS_VIOLATION.
  let disposed = false;
  const reportedAppErrorCodes = new Set<string>();
  const gracefulDispose = (): void => {
    if (disposed) return;
    disposed = true;
    void app.dispose().finally(() => previewRun.cleanup());
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
  assets: NonNullable<App['assets']>,
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
        .map((entry) => ({
          guid: entry.guid,
          kind: 'ui' as const,
          sourcePath: entry.sourcePath,
        })),
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
