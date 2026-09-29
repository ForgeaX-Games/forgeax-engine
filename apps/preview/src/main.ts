// apps/preview -- Vite host for asset-resident Cordis game plugins.
//
// Project roots compile into literal program tables; runtime mounting stays native Cordis.
// Composition:
//   1. createApp(canvas) -- one-shot engine wiring
//   2. load the selected project program table
//   3. provide GameHost, mount gameplay, then start the App
//
// The slug defaults to
// `game-default` and may be overridden via `?game=<slug>`.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import type { PackProgramHost } from '@forgeax/engine/pack/runtime';
import {
  createBrowserPackProgramHost,
  prepareBrowserPackProgramScope,
} from '@forgeax/engine/pack/runtime-browser';
import {
  type App,
  activateExecutionRoot,
  type CanvasAppError,
  createApp,
  type GameHost,
  gameHostPlugin,
  isAppError,
} from '@forgeax/engine-app';
import { createAssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import type { PluginPrograms } from '@forgeax/engine-plugin';
import { buildProfileModel, createProfiler } from '@forgeax/engine-profiler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { type CatalogEntry, ImportError } from '@forgeax/engine-types';
import { createUiLoader, type UiAsset, type UiError } from '@forgeax/engine-ui';
import { createPreviewInspection } from './preview-inspection';
import { captureSurfaceStandardEvidence } from './surface-standard-evidence';
import { PREVIEW_UI_SOURCE_GUID, type UiAuthoringAssetGateway } from './ui-authoring';
import { createPreviewUiRun, type PreviewUiRun, reportPreviewEngineFailure } from './ui-root';

interface TemplatePrograms {
  readonly root: string | null;
  createPrograms(
    sessionId: string,
    contextId: string,
    sessionGeneration: number,
    fallback?: PackProgramHost,
  ): PluginPrograms;
}

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
const previewPlugins = [webAudioPlugin(), audioPlugin(), skinningPlugin()];

const slug = new URLSearchParams(window.location.search).get('game') ?? 'game-default';
// The Surface evidence lane owns its four-cell World and deliberately
// publishes only the Surface asset roots.  Keep the ordinary gameplay
// bootstrap out of that lane so its unrelated default-scene dependencies
// cannot turn a shader readback into an asset-import failure.
const surfaceEvidenceMode = previewQuery.get('surfaceEvidence') === '1';

const templates: Record<
  string,
  { engine: () => Promise<TemplatePrograms>; host: () => Promise<TemplatePrograms> }
> = {
  'game-capability-lab': {
    engine: () => import('virtual:forgeax/plugin-programs/game-capability-lab/engine'),
    host: () => import('virtual:forgeax/plugin-programs/game-capability-lab/frontend'),
  },
  'depth-of-field': {
    engine: () => import('virtual:forgeax/plugin-programs/depth-of-field/engine'),
    host: () => import('virtual:forgeax/plugin-programs/depth-of-field/frontend'),
  },
  'brotato-3d': {
    engine: () => import('virtual:forgeax/plugin-programs/brotato-3d/engine'),
    host: () => import('virtual:forgeax/plugin-programs/brotato-3d/frontend'),
  },
  empty: {
    engine: () => import('virtual:forgeax/plugin-programs/empty/engine'),
    host: () => import('virtual:forgeax/plugin-programs/empty/frontend'),
  },
  'game-3d': {
    engine: () => import('virtual:forgeax/plugin-programs/game-3d/engine'),
    host: () => import('virtual:forgeax/plugin-programs/game-3d/frontend'),
  },
};
const selected = templates[slug === 'game-default' ? 'game-capability-lab' : slug];
if (!selected) throw new Error(`preview: unknown project ${slug}`);
const engine = surfaceEvidenceMode ? undefined : await selected.engine();
const host = surfaceEvidenceMode ? undefined : await selected.host();
if (slug === 'game-3d' && runtimeBinding === undefined) {
  throw new Error('preview: runtime vase requires the Pack runtime binding');
}
const runtimeProgramHost =
  engine !== undefined && slug === 'game-3d'
    ? createBrowserPackProgramHost(
        await prepareBrowserPackProgramScope(
          new URL('forgeax-pack-program-worker.js', document.baseURI).href,
        ),
      )
    : undefined;
const enginePrograms = engine?.createPrograms(
  crypto.randomUUID(),
  `preview:${slug}:engine`,
  1,
  runtimeProgramHost,
);

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
    ...(slug === 'game-3d' && runtimeBinding !== undefined
      ? { runtimePacks: { scopeId: runtimeBinding.scopeId } }
      : {}),
    plugins: previewPlugins,
    ...(enginePrograms === undefined ? {} : { pluginPrograms: enginePrograms }),
    ...(runtimeDevBinding === undefined ? {} : { assetRuntimeBinding: runtimeDevBinding }),
    ...(previewProfiler === undefined ? {} : { profiler: previewProfiler }),
    ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
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
  if (!app.pluginContext.runtimePacks) configureRuntimeAssetCatalog(assets, runtimeBinding);
  await assets.refreshCatalog();
  previewRun.authoring.bind(createPreviewUiAssetGateway(assets, runtimeBinding, import.meta.hot));
  const previewInspection = createPreviewInspection(app, previewRun.registerCleanup);

  const gameChannel = new MessageChannel();
  previewRun.registerCleanup(() => {
    gameChannel.port1.close();
    gameChannel.port2.close();
  });
  const gameHost: GameHost = {
    port: gameChannel.port1,
    canvas: previewCanvas,
    assets,
    app,
    renderer: app.renderer,
    // M2 D-9: wire the pointer-lock gate setter. The game template calls
    // setPointerLockAllowed(mode === 'fps') when switching modes; the
    // preview host delegates to the input backend's setPointerLockAllowed.
    // No lockProvider is injected — Web host goes W3C path.
    setPointerLockAllowed: (allowed: boolean) => app.input?.setPointerLockAllowed?.(allowed),
    uiRoot: previewRun.uiRoot,
    gameProjection: previewInspection.registrar,
  };

  try {
    await app.pluginContext.plugin(gameHostPlugin(gameHost));
    if (engine?.root) {
      const started = await activateExecutionRoot(app.pluginContext, {
        guid: engine.root,
      });
      previewRun.registerCleanup(() => {
        void started.fiber.dispose();
      });
    }
    if (host?.root) {
      const scope = app.pluginContext
        .isolate('assets')
        .isolate('pluginPrograms')
        .isolate('gameHost');
      if (!runtimeBinding) throw new Error('preview requires the Pack runtime binding');
      const catalog = createCatalogSource({
        url: import.meta.env.DEV
          ? runtimeBinding.catalogUrl
          : new URL('pack-index.json', document.baseURI).href,
        ...(import.meta.env.DEV ? { expectedScope: runtimeBinding } : {}),
      });
      const reader = createAssetRegistry({ catalog, scopeId: runtimeBinding.scopeId });
      const hostPrograms = host.createPrograms(
        crypto.randomUUID(),
        `preview:${slug}:host`,
        1,
        runtimeProgramHost,
      );
      const provider = scope.plugin({
        provide: ['assets', 'pluginPrograms', 'gameHost'],
        apply(ctx) {
          ctx.provide('gameHost', { ...gameHost, port: gameChannel.port2 });
          ctx.provide('assets', reader);
          ctx.provide('pluginPrograms', hostPrograms);
          ctx.effect(() => () => reader.dispose());
        },
      });
      try {
        await provider.await();
        const started = await activateExecutionRoot(scope, { guid: host.root });
        previewRun.registerCleanup(() => {
          void started.fiber.dispose().finally(() => provider.dispose());
        });
      } catch (cause) {
        await provider.dispose();
        throw cause;
      }
    }
  } catch (e: unknown) {
    previewRun.cleanup();
    console.error('[preview] gameplay activation rejected:', e);
    throw e;
  }
  if (!surfaceEvidenceMode) app.start();

  Object.assign(window, {
    __forgeaxSurfaceStandardEvidence: () =>
      captureSurfaceStandardEvidence(app, { resumeApp: !surfaceEvidenceMode }),
  });

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
  const importSource = async (guid: string): Promise<readonly CatalogEntry[] | ImportError> => {
    const response = await fetch(`${binding.importUrlBase}/${encodeURIComponent(guid)}`, {
      method: 'POST',
    });
    if (response.ok) {
      const imported = parseCatalogEntries(await response.json());
      if (imported.length > 0) return imported;
      return new ImportError({
        code: 'import-internal-error',
        expected: 'the import response to contain the published UI catalog row',
        hint: 'Inspect the producer publication and retry the preview import.',
        detail: { reason: `Import response contained no catalog entries for ${guid}` },
      });
    }
    return importErrorFromResponse(await readJsonResponse(response));
  };
  const mergeImportedEntries = (imported: readonly CatalogEntry[]): void => {
    const byGuid = new Map(entries.map((entry) => [entry.guid.toLowerCase(), entry] as const));
    for (const entry of imported) byGuid.set(entry.guid.toLowerCase(), entry);
    entries = [...byGuid.values()];
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
        if (imported instanceof ImportError) return { ok: false, error: imported };
        await refresh();
        // The import response is the producer's accepted publication. Merge
        // it after refresh so a transient/stale catalog read cannot erase the
        // row that was just made loadable.
        mergeImportedEntries(imported);
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
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`);
  return parseCatalogEntries(await response.json());
}

function parseCatalogEntries(body: unknown): CatalogEntry[] {
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
  if (err.code === 'asset-assembly-failed') {
    console.error(`[preview] AssetRuntimeAssemblyError ${err.code}: ${err.hint}`);
    return { code: err.code, detail: err.detail.kind };
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
