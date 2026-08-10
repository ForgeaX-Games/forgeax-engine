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
import { physicsPlugin } from '@forgeax/engine-physics';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createPreviewInspection } from './preview-inspection';
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
  const diagnostic = reportCreateError(app.error);
  reportPreviewEngineFailure(previewRun, diagnostic);
} else {
  await startPreview(app.value, previewRun);
}

async function startPreview(app: App, previewRun: PreviewUiRun): Promise<void> {
  const assets = app.renderer.assets;
  if (runtimeBinding === undefined) assets.configurePackIndex('/pack-index.json');
  else assets.configureRuntimeBinding(runtimeBinding);
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
      case 'app-paused-while-stop':
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
