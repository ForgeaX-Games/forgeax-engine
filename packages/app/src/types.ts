// @forgeax/engine-app -- shared types for createApp double-SSOT entry.
//
// AI users: see packages/app/src/index.ts for the public surface and
// packages/app/src/create-app.ts for the runtime implementation.
//
// M1 (this milestone) ships the skeleton: interfaces are final-shape, but
// start / stop / pause / resume / onError on the returned App are stubs
// that return Result.ok(undefined) and a no-op unsubscribe. The rAF main
// loop, dt clamp, error fan-out, and input attach internals land in
// later milestones (M2..M5 per plan-strategy section 7).

import type { AudioBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { Result, World } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import type { PhysicsWorld, PhysicsWorld2D } from '@forgeax/engine-physics';
import type { Plugin, PluginError } from '@forgeax/engine-plugin';
import type { RhiError, RhiInstance } from '@forgeax/engine-rhi';
import type {
  EngineEnvironmentError,
  PostProcessError,
  Renderer,
  RuntimeError,
} from '@forgeax/engine-runtime';
import type { ImportTransport } from '@forgeax/engine-types';

import type { AppError, AppErrorCode } from './errors';

// Re-export AppError + AppErrorCode (the canonical SSOT lives in
// `./errors`). Pre-M5 (M1..M4) referenced these as type-only declarations
// inside this file; M5 collapses to the single SSOT in `./errors.ts` per
// plan-strategy section 7 + research section 2.7.
export type { AppError, AppErrorCode };

/**
 * Structured error union surfaced through the App `onError` fan-out + the
 * assemble-form construction Result. Mirrors the `Renderer.onError` channel
 * (`RhiError | RuntimeError`) so a runtime-layer error fanned out by the
 * renderer (e.g. `'equirect-projection-failed'`) reaches host App listeners
 * verbatim, plus the App-layer `AppError`. AI users `switch (err.code)` over
 * the union: the disjoint `AppErrorCode` / `RhiErrorCode` / `RuntimeErrorCode`
 * literal sets let TS narrow each arm to the concrete class
 * (feat-20260531-skybox-env-background F-1: `RuntimeError` added alongside the
 * pre-existing `AppError | RhiError` pair).
 */
export type AppDispatchError = AppError | RhiError | RuntimeError | PostProcessError;

/**
 * Options for the assemble-form entry createApp({ renderer, world, ... }).
 *
 * Field semantics (final shape -- runtime use lands in M2..M5):
 *   - renderer: caller-owned Renderer (host already invoked createRenderer).
 *   - world:    caller-owned World (host already invoked new World()).
 *   - input:    InputBackend handle the host-side attached. When omitted the
 *               assemble entry skips input attach (caller manages input).
 *   - schedule: opaque hook for advanced scheduling (typed unknown in M1;
 *               narrowed in a later feat once the schedule shape lands).
 *   - maxDt:    dt clamp ceiling override (defaults to MAX_DT_DEFAULT in M2).
 *   - silenceUnhandledErrors: when true, suppresses the console.error
 *               fallback inside the error fan-out (M4).
 */
export interface AppAssembleArgs {
  readonly renderer: Renderer;
  readonly world: World;
  /** Unified plugin list (M1 feat-20260623-plugin-system-unify-build-world-protocol). */
  readonly plugins?: Plugin[];
  readonly schedule?: unknown;
  readonly maxDt?: number;
  readonly silenceUnhandledErrors?: boolean;
}

/**
 * Options for the canvas-form thin wrapper createApp(canvas, opts?, bundler?).
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: self-describing
 * surface -- no longer `extends RendererOptions`. The 7 app-only fields
 * (input / audio / physics / schedule / maxDt / silenceUnhandledErrors) plus
 * the 2 RHI escape-hatch fields (rhi / rawDeviceForContextConfigure) are
 * listed inline, so IDE autocomplete shows AI users a clean surface
 * without inheriting now-disallowed slots like clearColor (M1, on Camera)
 * and shaderManifestUrl (M2, on BundlerOptions / 3rd arg). The escape
 * hatches stay discoverable for the RHI debugging path (charter P1 -- not
 * default noise, but reachable when the AI user scrolls the type).
 */
export interface CreateAppOptions {
  /** Unified plugin list (M1 feat-20260623-plugin-system-unify-build-world-protocol). */
  readonly plugins?: Plugin[];
  /** Opaque schedule hook (typed unknown in M1; narrowed in later feat). */
  readonly schedule?: unknown;
  /** dt clamp ceiling override (defaults to MAX_DT_DEFAULT in M2). */
  readonly maxDt?: number;
  /**
   * When true, suppresses the console.error fallback inside the error
   * fan-out for hosts that prefer total silence (M4 default: false).
   */
  readonly silenceUnhandledErrors?: boolean;
  /**
   * RHI escape hatch -- forwarded verbatim to createRenderer. Same semantics
   * as `RendererOptions.rhi` (the createRenderer third-party-RHI-instance
   * injection point). Use only for testing / pinning a specific backend /
   * advanced AI users that ship their own RhiInstance shim.
   */
  readonly rhi?: RhiInstance | undefined;
  /**
   * D-S1 raw GPUDevice escape hatch -- forwarded verbatim to createRenderer.
   * Same semantics as `RendererOptions.rawDeviceForContextConfigure`. Used
   * by the apps/hello/triangle bootstrap, where the host configures the
   * canvas's GPUCanvasContext outside the RHI surface.
   */
  readonly rawDeviceForContextConfigure?: unknown | (() => unknown | undefined);
  /**
   * Neutral PointerLock gate forwarded verbatim to the canvas-form input
   * attach (attachInputAuto → attachBrowserInputBackend). When it returns
   * false, a canvas click does NOT capture the cursor. Absent => always-lock
   * (standalone game behaviour). The engine never learns WHY locking is
   * (dis)allowed — the host owns that decision (e.g. an editor viewport that
   * only allows lock in its play·game quadrant). Ignored by the assemble form
   * (host-managed input owns its own lock policy).
   */
  readonly pointerLockAllowed?: () => boolean;
}

/**
 * Bundler-layer injection for the canvas-form createApp(canvas, opts, bundler?)
 * and createRenderer(canvas, opts, bundler?).
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: this is the SSOT
 * for build-tool emit knowledge that the engine consumes at runtime.
 * Aggregates two host-injected channels:
 *
 *   - importTransport: dev-only ImportTransport that the engine threads to
 *     the AssetRegistry third ctor slot so a DDC miss can lazy-import.
 *     Absent => shipped form (DDC miss fails fast with `asset-not-imported`).
 *
 *   - shaderManifestUrl: the path the host's vite-plugin-shader emit step
 *     wrote `manifest.json` to. Absent (or `BundlerOptions` itself omitted)
 *     => createRenderer falls back to '/shaders/manifest.json'
 *     (createRenderer.ts D-2 q5-A) so the LO 1.1 zero-config takeoff path
 *     keeps working without any explicit injection.
 *
 * Both fields are optional so `BundlerOptions = {}` is a valid call shape.
 * M3 collapses the typical demo callsite to `forgeaxBundlerAdapter()` (a
 * factory exported by `virtual:forgeax/bundler`), which returns an object
 * with this same structural shape -- type compatibility is enforced by
 * TypeScript structural typing (D-4: vite-plugin-shader does NOT import
 * `@forgeax/engine-app`, so this interface is the consumer-side SSOT).
 */
export interface BundlerOptions {
  /**
   * Dev-only ImportTransport forwarded verbatim to createRenderer (and thence
   * to the AssetRegistry third ctor slot). Absent => shipped form (a DDC miss
   * fails fast with `asset-not-imported`).
   *
   * The `| undefined` widening is necessary because exactOptionalPropertyTypes
   * is enabled at the workspace level (tsconfig.base.json); it lets tests
   * (and demos that gate on a build-mode flag) write `{ importTransport:
   * undefined }` without a TS2379 error.
   */
  readonly importTransport?: ImportTransport | undefined;
  /**
   * vite-plugin-shader emit URL (the path the build wrote `manifest.json`
   * to). Absent => createRenderer falls back to '/shaders/manifest.json'.
   * Tests can inject via a `data:application/json,...` URL to bypass fetch.
   *
   * The `| undefined` widening lets tests opt into the zero-entry mode by
   * writing `{ shaderManifestUrl: undefined }` (the createRenderer body
   * checks `'shaderManifestUrl' in bundler` to distinguish "absent" from
   * "explicitly undefined"; see D-2 q5-A in plan-strategy).
   */
  readonly shaderManifestUrl?: string | undefined;
}

/**
 * App handle returned by createApp(...). Host owns the lifecycle and
 * interacts with the rAF loop through start / stop / pause / resume +
 * the structured error fan-out via onError.
 *
 * M1 skeleton: start / stop / pause / resume return Result.ok(undefined)
 * synchronously and onError returns a no-op unsubscribe. The 4-state
 * machine + idempotent transitions land in M2 (plan-strategy section 7).
 */
export interface App {
  /** Caller-owned Renderer (reference equality with the assemble input). */
  readonly renderer: Renderer;
  /** Caller-owned World (reference equality with the assemble input). */
  readonly world: World;
  /**
   * Plugin registry produced by runPlugins() —— Map<string, Plugin>.
   * The caller passes this to wireDefaultInspectors context so the
   * inspector's 'plugins' RPC method can enumerate loaded plugins.
   * Always present after a successful createApp call.
   */
  readonly pluginRegistry: Map<string, import('@forgeax/engine-plugin').Plugin>;
  /** InputBackend handle when input attach is enabled; undefined otherwise. */
  readonly input?: InputBackend;
  /** AudioBackend handle when audio attach is enabled; undefined otherwise. */
  readonly audio?: AudioBackend;
  /**
   * PhysicsWorld handle when physicsPlugin is loaded; undefined
   * otherwise. physicsPlugin.build awaits the WASM import -- createApp
   * resolves ONLY after the WASM module is loaded, so this field is
   * populated immediately when createApp returns (AC-06: no timing gap).
   */
  readonly physics?: PhysicsWorld | PhysicsWorld2D | undefined;
  /**
   * Immediate-mode debug-draw overlay instance (feat-20260615 debug-draw M5).
   *
   * Created automatically during createApp (canvas form). AI users call
   * `app.debugDraw.line(a, b, RED)` in any system and the overlay renders
   * at frame-end via the render-graph's debug-overlay pass. Shape calls are
   * immediate-mode — vertices accumulate per-frame and are flushed at the
   * tonemap suffix; stale data from frame N-1 is never visible in frame N.
   *
   * Undefined when debug-draw is not wired (assemble-form createApp with
   * no explicit debugDraw creation — the auto-attach is canvas-form only).
   */
  readonly debugDraw?: DebugDraw | undefined;
  /**
   * Begin rAF scheduling. Idempotent guard lands in M2:
   *   - first call: Result.ok(undefined)
   *   - second call (already running): Result.err({ code: 'app-already-running' })
   * M1 stub returns Result.ok(undefined) unconditionally.
   */
  start(): Result<void, AppError>;
  /**
   * Stop rAF scheduling. State-machine semantics land in M2:
   *   - 'idle' state second call: Result.err({ code: 'app-not-started' })
   *   - 'paused' state: Result.err({ code: 'app-paused-while-stop' })
   *   - 'running' state: Result.ok(undefined)
   * M1 stub returns Result.ok(undefined) unconditionally.
   */
  stop(): Result<void, AppError>;
  /**
   * Pause rAF scheduling. Idempotent in 'paused' state. M1 stub returns
   * Result.ok(undefined) unconditionally; full state machine in M2.
   */
  pause(): Result<void, AppError>;
  /**
   * Resume rAF scheduling from paused state. M1 stub returns
   * Result.ok(undefined) unconditionally; full state machine in M2.
   */
  resume(): Result<void, AppError>;
  /**
   * Subscribe to structured errors fan-out from the rAF loop. Returns an
   * unsubscribe handle. The callback signature deliberately excludes raw
   * Error (charter P3 -- AI users walk .code, not message strings).
   *
   * M1 stub: registers nothing and returns a no-op unsubscribe; full
   * fan-out registry lands in M4 (plan-strategy section 7).
   */
  onError(cb: (err: AppDispatchError) => void): () => void;
  /**
   * Last error captured by the M4 cleanup funnel. Useful for host
   * self-inspection on device-lost without requiring an onError
   * listener up-front (charter P3 explicit failure: silent device-lost
   * is a footgun). Reads `undefined` until the funnel runs once.
   *
   * M4 (w13) wires this for stop / device-lost / exception throw paths
   * (R-4 triple-funnel). The slot updates on every funnel invocation,
   * so subsequent device-lost-after-stop events overwrite the field --
   * AI users get the latest signal, not the first one.
   */
  readonly lastError?: AppDispatchError | undefined;
  /**
   * Register a per-frame update callback. The callback receives dt
   * (clamped delta-time in seconds) and executes between Time resource
   * injection and world.update() every frame (plan-strategy D-1).
   *
   * Thin proxy over FrameLoopHandle.addUpdateCallback (plan-strategy
   * D-2). GameContext.registerUpdate delegates through this method.
   */
  registerUpdate(fn: (dt: number) => void): void;
  /**
   * @internal
   * Live `DebugRhiInstance` recorder proxy when `FORGEAX_ENGINE_RHI_DEBUG=1` is set;
   * `undefined` otherwise. Demo / e2e harness code calls `_debugRhi.arm(N)`
   * + later `_debugRhi.finalize()` directly. Production code should
   * reach the same pipeline through the WS:5732 RPC `debug.captureFrame`
   * method (which routes through `_debugAdapter`).
   * Typed as `unknown` here to avoid pulling
   * `@forgeax/engine-rhi-debug` into the `@forgeax/engine-app` type
   * surface — host code that wants the typed shape imports
   * `DebugRhiInstance` separately and casts.
   */
  readonly _debugRhi?: unknown;
  /**
   * @internal
   * `DebugRhiAdapter` instance that the host wired into
   * `wireDefaultInspectors({ debugRhi: ... })`. Exposed for in-process
   * tests to drive captureFrames / inspectAt / replayDispose without
   * setting up the WS:5732 stack. `undefined` when `FORGEAX_ENGINE_RHI_DEBUG !== '1'`.
   * Same `unknown`-typed escape as `_debugRhi` to keep the rhi-debug
   * package out of the app's public type surface.
   */
  readonly _debugAdapter?: unknown;
  /**
   * Handle for the remote eval server started by createApp (dev mode).
   *
   * `undefined` in production builds and headless/dawn-node without explicit
   * opt-in. When present, the host can read `app.remote.port` for WS connection
   * details or call `await app.remote.close()` to tear down the server
   * (feat-20260629-inspector-two-layer-model M4 / w20).
   *
   * Typed as {@link RemoteHandle} from `@forgeax/engine-types` — a neutral
   * package with no dependency on `@forgeax/engine-remote`.
   */
  readonly remote?: import('@forgeax/engine-types').RemoteHandle | undefined;
}

/**
 * Error union returned by the assemble-form entry. The canvas-form thin
 * wrapper widens this with EngineEnvironmentError (createRenderer
 * construction-time failure path -- plan-strategy D-5 / requirements AC-01).
 *
 * feat-20260623-plugin-system-unify (M2 / D-7): widened with PluginError
 * (duplicate-plugin / plugin-build-failed) since runPlugins now drives the
 * assemble-form wiring and can fail with a structured plugin error.
 */
export type AssembleAppError = AppError | RhiError | PluginError;

/**
 * Error union returned by the canvas-form thin wrapper. Extends
 * AssembleAppError with EngineEnvironmentError to surface
 * createRenderer construction-time failures unchanged (preserves
 * .detail.webgpuError per requirements section 6.1).
 *
 * PluginError rides in via AssembleAppError (the canvas form also runs
 * runPlugins; M2 / D-7).
 */
export type CanvasAppError = AssembleAppError | EngineEnvironmentError;
