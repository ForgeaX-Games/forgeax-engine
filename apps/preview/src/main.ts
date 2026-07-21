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
  type BootstrapContext,
  type BootstrapEntry,
  type CanvasAppError,
  createApp,
  isAppError,
  isLoadGameError,
  loadGame,
} from '@forgeax/engine-app';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('preview: missing <canvas id="app"> in index.html');

// Wire dev-mode ImportTransport so loadByGuid for raw-source assets in
// templates/<slug>/scene.pack.json (and the engine-assets submodule's
// sky.hdr) lazy-imports via vite-plugin-pack's POST /__import route.
// Absent transport => any DDC miss fails fast with 'asset-not-imported'.
const app = await createApp(
  canvas,
  {},
  {
    ...forgeaxBundlerAdapter(),
    importTransport: createDevImportTransport(),
  },
);
if (!app.ok) {
  reportCreateError(app.error);
  throw new Error('preview: createApp failed');
}

const assets = app.value.renderer.assets;
assets.configurePackIndex('/pack-index.json');

const ctx: BootstrapContext = {
  assets,
  app: app.value,
  // M2 D-9: wire the pointer-lock gate setter. The game template calls
  // setPointerLockAllowed(mode === 'fps') when switching modes; the
  // preview host delegates to the input backend's setPointerLockAllowed.
  // No lockProvider is injected — Web host goes W3C path.
  setPointerLockAllowed: (allowed: boolean) => app.value.input?.setPointerLockAllowed?.(allowed),
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
  reportLoadError(loaded.error);
  throw new Error('preview: loadGame failed');
}

const entry: BootstrapEntry = loaded.value;
try {
  await entry(app.value.world, ctx);
} catch (e: unknown) {
  console.error('[preview] bootstrap rejected:', e);
  throw e;
}
app.value.start();

// Graceful GPU shutdown: dispose before reload. Without this, rapid reloads
// leak GPU contexts -> STATUS_ACCESS_VIOLATION.
let disposed = false;
const gracefulDispose = (): void => {
  if (disposed) return;
  disposed = true;
  app.value.stop();
  app.value.renderer.dispose();
};
window.addEventListener('message', (ev) => {
  if ((ev.data as { type?: string } | null)?.type === 'VAG_PREVIEW_DISPOSE') {
    gracefulDispose();
  }
});
window.addEventListener('pagehide', gracefulDispose);
app.value.onError((err: { code?: string }) => {
  if (err.code === 'device-lost') {
    window.parent?.postMessage({ type: 'VAG_DEVICE_LOST' }, '*');
  }
});

function reportCreateError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[preview] EngineEnvironmentError: webgpu inner=${code}`);
    return;
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
        return;
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
        return;
    }
  }
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
