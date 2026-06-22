# @forgeax/engine-app

> **App shell + game loop helper for forgeax-engine** — `Promise<Result<App, ...>>` factory wired to `requestAnimationFrame` + structured error fan-out + auto input attach. The first forgeax package to walk the full charter P3 (`Promise<Result<...>>`) shape on a top-level factory.

## One-screen takeoff (<=3 statements)

```ts
import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app')!;
const app = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!app.ok) throw app.error;
app.value.start();
```

The thin wrapper `createApp(canvas, opts?, bundler?)` allocates a fresh `World`, calls `createRenderer(canvas, opts, bundler)`, attaches the browser input backend (skip with `opts.input = false`), and wires the rAF main loop. Discover the API via IDE autocomplete on `@forgeax/engine-app`.

Per-frame clear color now lives on the `Camera` component (`clearR/G/B/A`), not on `RendererOptions` — see `packages/runtime/README.md` §Camera clear color. The canonical sample is `apps/hello/app/src/main.ts`.

## Third-arg `BundlerOptions`

The optional third positional arg of both `createApp` and `createRenderer` is a `BundlerOptions` object aggregating the build-time bundler-injected wiring:

| Field | Type | Default | Purpose |
|:--|:--|:--|:--|
| `shaderManifestUrl` | `string` | `'/shaders/manifest.json'` | URL the runtime fetches at boot to populate `ShaderRegistry` (auto-emitted by `@forgeax/engine-vite-plugin-shader`'s `generateBundle` + dev middleware) |
| `importTransport` | `ImportTransport \| undefined` | `undefined` | Optional dev-only transport that resolves a DDC miss through `POST /__import/<guid>` against `@forgeax/engine-vite-plugin-pack` |

Because the manifest URL and the `ImportTransport` are **build-time concerns**, the canonical AI-user form is to source them from the build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`:

```ts
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
const app = await createApp(canvas, {}, forgeaxBundlerAdapter());
```

The adapter returns `{ shaderManifestUrl, importTransport: undefined }`. Demos that need a real dev transport spread the adapter and inject the transport explicitly:

```ts
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
const app = await createApp(canvas, {}, bundler);
```

> AC-12 grep gate enforces zero `'/shaders/manifest.json'` literals in `apps/`; the adapter is the only sanctioned surface in demo source.

## API index

| Entry | Shape | Purpose |
|:--|:--|:--|
|:--|:--|:--|
| `createApp(canvas, opts?, bundler?)` | async factory thin wrapper | One-screen takeoff; calls `createRenderer` + `new World()` + auto-attach + rAF. Third arg `BundlerOptions` (e.g. `forgeaxBundlerAdapter()`) carries bundler-emit substances (`shaderManifestUrl` / `importTransport`). Returns `Promise<Result<App, AppError \| RhiError \| EngineEnvironmentError>>` |
| `createApp({ renderer, world, input?, schedule?, ... })` | async factory assemble form | Host already owns `renderer = await createRenderer(canvas, opts)` + `world = new World()`; pass them in by reference. Returns `Promise<Result<App, AppError \| RhiError>>` (no `EngineEnvironmentError` — host-owned) |
| `App.renderer` | `Renderer` readonly | Reference equality with the assemble input |
| `App.world` | `World` readonly | Reference equality with the assemble input |
| `App.input` | `InputBackend \| undefined` readonly | Frozen `InputSnapshot` producer when auto-attach engaged; `undefined` when `opts.input === false` |
| `App.start()` | `() => Result<void, AppError>` | Begin rAF scheduling. Idempotent state machine: second call returns `'app-already-running'` |
| `App.stop()` | `() => Result<void, AppError>` | Cancel rAF; trigger triple-funnel cleanup (input detach + removeSystem + device-lost unsubscribe). Returns `'app-not-started'` when called from idle state, `'app-paused-while-stop'` when called from paused state |
| `App.pause()` / `App.resume()` | `() => Result<void, AppError>` | rAF paused/running state toggle (idempotent) |
| `App.onError(cb)` | `((err: AppError \| RhiError) => void) => () => void` | Multi-listener registry; returns unsubscribe handle. **Raw `Error` not in signature** (charter P3) |
| `App.lastError` | `AppError \| RhiError \| undefined` readonly | Last error captured by the cleanup funnel (stop / device-lost / exception throw); useful for host self-inspection without an `onError` listener |
| `AppError` | `class extends Error` | 5-member closed `code` union; 4-field surface (`.code` / `.expected` / `.hint` / `.detail`) byte-for-byte parallel to `RhiError` |
| `MAX_DT_DEFAULT` | `number` | dt clamp ceiling = 1/30s. Override via `opts.maxDt` |

## Assemble form (named args + explicit injection)

```ts
import { World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { createRenderer } from '@forgeax/engine-runtime';
import { attachBrowserInputBackend } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const renderer = await createRenderer(canvas, {}, forgeaxBundlerAdapter());
const world = new World();
const input = attachBrowserInputBackend(canvas).backend;

const app = await createApp({ renderer, world, input });
if (!app.ok) throw app.error;
app.value.start();
```

When `args.input` is supplied, the assemble form treats it as **host-managed**: it is exposed verbatim as `app.input`, and the host is responsible for detaching it (no auto-cleanup on `stop`). Use this form when the host wants explicit control over input lifetime.

## AppError 5-member closed union

`AppErrorCode` (SSOT: `packages/app/src/errors.ts`):

| Code | Trigger |
|:--|:--|
| `'app-not-started'` | `stop()` / `pause()` / `resume()` invoked while the rAF loop is in `'idle'` or `'stopped'` (post-device-lost terminal sink). The handle has no live frame to interrupt; AI users either call `start()` first or rebuild the app via `createApp({...})` |
| `'app-already-running'` | Second `start()` invocation against an already-running handle; the call is a no-op state-machine-wise (state preserved) |
| `'app-canvas-detached'` | `createApp(canvas)` thin wrapper found `canvas.isConnected === false` at entry. `detail.canvasId?: string` |
| `'app-paused-while-stop'` | `stop()` invoked from `'paused'` state. Forces host to call `resume()` first (avoids stop state-machine ambiguity) |
| `'app-system-update-failed'` | `world.update()` threw a synchronous exception during the rAF tick. `detail = { cause: unknown, systemName?: string }` carries the wrapped EcsError or other thrown value (D-4) |

Plan-strategy D-3 lock: device-lost stays on `RhiErrorCode` (18-member union); `AppError` does **not** add a sixth `'app-device-lost'`. Host `onError` listeners receive `RhiError({ code: 'device-lost' })` verbatim through the fan-out.

## onError multi-listener + console.error fallback

```ts
const off1 = app.value.onError((err) => analytics.report(err));
const off2 = app.value.onError((err) => statusBar.show(err.hint));

// later
off1();  // listener 1 unsubscribed; listener 2 still active
```

`onError(cb)` registers a listener and returns an unsubscribe handle (parallel to `Renderer.onError`). When **no** listener is registered and `opts.silenceUnhandledErrors !== true`, the fan-out calls `console.error(err)` so even the ≤3-statement takeoff form surfaces failures in devtools (charter P3 explicit failure: silent device-lost is unacceptable).

## Error handling: dual-layer instanceof + switch (D-6)

The error union for `createApp(canvas, opts?)` is `AppError | RhiError | EngineEnvironmentError`. `AppError` and `RhiError` carry a `.code` discriminant; `EngineEnvironmentError` does **not** (it extends `Error` and exposes `.detail.webgpuError`). The canonical consumption pattern is dual-layer:

```ts
function reportError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  switch (err.code) {
    case 'app-not-started':
    case 'app-already-running':
    case 'app-canvas-detached':
    case 'app-paused-while-stop':
    case 'app-system-update-failed':
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
      console.error(`${err.code}: ${err.hint}`);
      return;
  }
}
```

The `switch (err.code)` is exhaustive across 5 + 18 = 23 cases (`AppErrorCode | RhiErrorCode`); tsc strict mode guards completeness, no default branch needed. Live exemplar: `apps/hello/app/src/main.ts`.

<!-- TODO(future-feat): once EngineEnvironmentError adopts the 4-field
     surface (.code / .expected / .hint / .detail), collapse the dual-layer
     to a single switch. Tracking: feat-future-engine-env-error-result. -->

## Naming convention (AC-12 dual assertion)

`packages/app/src/**` does **not** export anything named `App` (export ban — `export const App` / `export class App` / `export function App` / `export default class App` / `export default function App` / `export interface App`/`export type App = ...` / `export { App ... }` / `export { ... as App }` are forbidden). Likewise no ECS registration literal `name: 'App'` may appear (`defineComponent({ name: 'App', ... })` etc. are forbidden). The `App` identifier is reserved for a future ECS Component (OOS-7 spinoff). The `App` *interface* lives in `types.ts` but is `App` only in interface form — no value export collides. Enforced by `scripts/check-app-package-no-component.mjs` (CI primary-pnpm gate).

## Advanced opts (collapsible)

<details>
<summary><strong>maxDt / silenceUnhandledErrors / input / schedule (CreateAppOptions advanced)</strong></summary>

| Field | Default | Purpose |
|:--|:--|:--|
| `maxDt` | `MAX_DT_DEFAULT` (1/30s) | dt clamp ceiling. `dt = Math.min(Math.max(rawDt, 0), maxDt)`. Negative `rawDt` (system clock rewind) → 0 |
| `silenceUnhandledErrors` | `false` | When `true`, suppresses the `console.error` fallback inside the error fan-out (host accepts total silence). When no `onError` listener is registered AND this flag is `false`, errors land in `console.error` |
| `input` | `true` (canvas form) | Set to `false` to skip `attachBrowserInputBackend(canvas)` + frame-start scan system registration. Use this for hosts that do not need keyboard/mouse (hello-cube / hello-room etc.) |
| `schedule` | `undefined` | Opaque hook for advanced scheduling (typed `unknown` in MVP; narrowed in a later feat once the schedule shape lands) |
| `rhi` / `rawDeviceForContextConfigure` | inherited from `RendererOptions` | RHI escape hatches forwarded into `createRenderer` byte-for-byte. **`shaderManifestUrl`** moved to **third-arg `BundlerOptions`** (post feat-20260608); **`clearColor`** moved to **`Camera` component fields `clearR/clearG/clearB/clearA`** (post feat-20260608) |

</details>

## alt-tab / wall-clock drift note (R-3)

`@forgeax/engine-app` does **not** subscribe to `document.visibilitychange`. After a long alt-tab in Chromium, `requestAnimationFrame` is throttled to ~1 Hz, accumulating wall-clock vs game-clock drift. The `dt` clamp (`MAX_DT_DEFAULT = 1/30s`) caps the per-tick advance, but cumulative drift over minutes can still surprise host business logic (e.g. a `tetris` drop timer perceiving "time stopped").

Hosts that care about wall-clock alignment should opt in via:

```ts
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') gameClock.resync();
  else gameClock.snapshot();
});
```

Not subscribing by default is a deliberate charter P3 boundary (host self-decides). A future spinoff (`app.attachVisibilityHandler()` helper) is tracked under R-3.

## OOS (out of scope for this feat)

| OOS | What | Why |
|:--|:--|:--|
| OOS-1 | Fixed-timestep accumulator (`fixedDt` / `accumulated`) | `'Time'` Resource ships single field `{ dt }` only; fixed-timestep is a separate feat |
| OOS-2 | `app.disposeWorld()` / explicit `device.destroy` | Lifecycle is host-driven; cleanup funnel covers detach + listener unsubscribe |
| OOS-3 | `document.visibilitychange` subscription | See alt-tab note above; host self-decides |
| OOS-4 | Schedule labels / scheduler API | `args.schedule` typed `unknown` until the schedule shape lands |
| OOS-5 | gamepad / touch / hot-reload input | Tracked in `@forgeax/engine-input` OOS-1 |
| OOS-6 | Migrate existing 13 hosts | Each host migrates as a separate small feat once the API stabilises |
| OOS-7 | `App` ECS Component | `App` identifier reserved; AC-12 grep gate enforces |
| OOS-8 | `engine-console` integration | Inspector roots exposed by host directly via `wireDefaultInspectors` |
| OOS-9 | RhiCanvasContext direct configure | `createApp(canvas)` thin wrapper handles WebGPU canvas-context configure internally |

## Host-engine contract

The boundary between host (DOM, canvas, UI) and engine (renderer, world, frame loop) is defined by a single-source contract document. Every host-side decision about canvas ownership, resize, aspect sync, DOM overlay, and lifecycle converges there.

- **Contract SSOT**: [`docs/how-to/2026-06-18-host-engine-contract.md`](../../docs/how-to/2026-06-18-host-engine-contract.md) -- one-page proposition, six contact surfaces with single ownership, `createApp` vs `createRenderer` path differences, scope boundaries, and standard boilerplate (resize + aspect-sync, video cutscene pause -> overlay -> resume, worldToScreen DOM follow).
- **createApp path**: auto-wires aspect-sync sidecar (canvas size -> `Camera.aspect` every frame) plus six other subsystems. Use this for every new host.
- **createRenderer path**: no aspect-sync; the host manages `Camera.aspect` itself. The tetris demo (`apps/tetris/src/main.ts`) is the documented counter-example -- new hosts should not copy it.

## References

- One-screen takeoff exemplar: `apps/hello/app/src/main.ts`
- Assemble form exemplar: `packages/app/__tests__/thin-wrapper.browser.test.ts`
- AppError 5-member union + APP_ERROR_HINTS / APP_EXPECTED: `packages/app/src/errors.ts`
- Frame-loop state machine: `packages/app/src/internal/frame-loop.ts`
- Cleanup triple-funnel (stop / device-lost / exception): `packages/app/src/internal/cleanup.ts`
- Input attach: `attachInputAuto` inserts the `InputBackend` under `INPUT_BACKEND_KEY` and adds the `InputFrameStartScan` system token (a top-level `defineSystem`); the legacy per-backend factory is retired. The `@forgeax/engine-input` README is the SSOT for the wiring recipe.
