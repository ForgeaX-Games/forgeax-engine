// @forgeax/engine-app -- createApp double-SSOT entry (M3 wiring).
//
// This file ships the final-shape signatures for both overload routes
// (canvas thin wrapper + assemble form per plan-strategy D-5):
//
//   - createApp({ renderer, world, ... })  -- assemble form: returns an
//     App with the supplied renderer / world wired through; the M2 rAF
//     frame-loop + state machine + dt clamp drive start / stop / pause /
//     resume. M3 lands listener-registry-backed onError + input-attach
//     plumbing: when the host passes a pre-built InputBackend through
//     args.input, the assemble form treats it as host-managed (no auto
//     attach, no auto cleanup -- the host owns the lifetime).
//
//   - createApp(canvas, opts?)             -- canvas form (M3 partial):
//     calls createRenderer(canvas, opts?), constructs a new World, and
//     (when opts.input !== false) wires the auto input-attach helper so
//     world.getResource('InputSnapshot') is populated each frame.
//     Falls through to the assemble form for the rest of the wiring.
//     Full canvas form (canvas-detached check, EngineEnvironmentError
//     catch, console.error fallback) lands in M4 (plan-strategy section 7).
//
// 'tagName' in arg dispatch (per plan-strategy D-5): HTMLCanvasElement
// inherits .tagName from HTMLElement, so the property test cleanly
// separates the canvas argument from the AppAssembleArgs plain object.

import {
  ASSET_REGISTRY_RESOURCE_KEY,
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioBackend,
  AudioListener,
} from '@forgeax/engine-audio';
import {
  createWebAudioBackend,
  syncListenerFromWorldMatrix,
  WebAudioEngine,
} from '@forgeax/engine-audio-webaudio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import {
  createQueryState,
  Entity,
  type EntityHandle,
  err,
  ok,
  queryRun,
  type Result,
  World,
} from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import { INPUT_BACKEND_KEY } from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';
import type { RhiInstance } from '@forgeax/engine-rhi';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import type { CreateShaderModuleFn, DebugRhiInstance } from '@forgeax/engine-rhi-debug';
import {
  animationPlugin,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  createDebugDrawOnReady,
  createRenderer,
  EngineEnvironmentError,
  PROPAGATE_TRANSFORMS_SYSTEM,
  type Renderer,
  type RendererError,
  Transform,
  timePlugin,
  transformPlugin,
} from '@forgeax/engine-runtime';
import { statePlugin } from '@forgeax/engine-state';
import type { AppErrorCode, AppErrorDetailFor } from './errors';
import { AppError } from './errors';
import { makeCleanupFunnel } from './internal/cleanup';
import { ErrorFanoutRegistry } from './internal/error-fanout';
import { createFrameLoop } from './internal/frame-loop';
import { registerCaptureHmrListener } from './internal/hmr-capture-listener';
import { attachInputAuto } from './internal/input-attach';
import { resolveRemoteServeFlag } from './internal/remote-serve-flag';
import { resolveRhiDebugFlag } from './internal/rhi-debug-flag';
import { runPlugins } from './internal/run-plugins';
import { inputPlugin } from './plugin-factories';
import type {
  App,
  AppAssembleArgs,
  AppDispatchError,
  AssembleAppError,
  BundlerOptions,
  CanvasAppError,
  CreateAppOptions,
} from './types';

function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

/**
 * createApp(canvas, opts?, bundler?) -- canvas thin wrapper SSOT (per
 * plan-strategy D-5). Resolves with Result.ok(app) on success; failure routes
 * through AppError | RhiError | EngineEnvironmentError per requirements AC-01.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: the third arg is
 * `BundlerOptions` (importTransport + shaderManifestUrl) -- the SSOT for
 * host-injected build-tool emit knowledge. M3 demos collapse the third-arg
 * literal to `forgeaxBundlerAdapter()` exported by `virtual:forgeax/bundler`.
 *
 * M3 ships the path needed by AC-05 (auto input-attach + scan system +
 * cleanup on stop). M4 finalises the canvas-detached guard +
 * EngineEnvironmentError try/catch + onError default fallback.
 *
 * The host-engine contract defines the boundary between host (DOM, canvas, UI)
 * and engine (renderer, world, frame loop). Only the `createApp(canvas)` path
 * auto-wires the aspect-sync sidecar; the assemble form and bare
 * `createRenderer` path do not.
 *
 * @see {@link https://github.com/Forgeax/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 */
export function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: BundlerOptions,
): Promise<Result<App, CanvasAppError>>;

/**
 * createApp({ renderer, world, input?, schedule?, ... }) -- assemble-form
 * SSOT (per plan-strategy D-5). Host already owns renderer / world; the
 * returned App holds them by reference equality (per AC-02).
 *
 * M3 wires the rAF frame-loop + listener-registry-backed onError. When
 * args.input is supplied, the assemble form treats it as host-managed:
 * it is exposed verbatim as app.input, and the host is responsible for
 * detaching it (no auto-cleanup on stop). The canvas form is the entry
 * that engages the auto-attach helper (input-attach.ts).
 */
export function createApp(args: AppAssembleArgs): Promise<Result<App, AssembleAppError>>;

export function createApp(
  arg: HTMLCanvasElement | AppAssembleArgs,
  opts?: CreateAppOptions,
  bundler?: BundlerOptions,
): Promise<Result<App, CanvasAppError>> {
  if ('tagName' in arg) {
    return createAppFromCanvas(arg, opts, bundler);
  }
  return createAppFromAssemble(arg);
}

async function createAppFromCanvas(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions | undefined,
  // feat-20260608-create-app-param-surface-trim / M2 / D-3: BundlerOptions is
  // the host-injection SSOT (importTransport + shaderManifestUrl). Forwarded
  // verbatim to createRenderer's third arg, so the engine reads
  // shaderManifestUrl in its ShaderRegistry fallback (D-2 q5-A) and threads
  // importTransport to AssetRegistry (AC-05 / R-4: keeps build-tool
  // injection out of RendererOptions / CreateAppOptions).
  bundler: BundlerOptions | undefined,
): Promise<Result<App, CanvasAppError>> {
  // M4: 4-step thin wrapper per plan-strategy D-5.
  //
  // Step 1: canvas-detached fail-fast guard (AC-08). isConnected returns
  //   false when the canvas is not in the document tree, including freshly
  //   document.createElement('canvas') without appendChild. Returning
  //   Result.err here short-circuits before createRenderer fires off any
  //   async adapter / device / shader work that would only fail later.
  if (!canvas.isConnected) {
    return err(
      makeAppError(
        'app-canvas-detached',
        'canvas.isConnected === true at createApp(canvas) entry',
        'append the canvas to the document tree before calling createApp; or use the assemble entry createApp({ renderer, world }) when the host already manages canvas lifetime',
        {},
      ),
    );
  }

  // Step 2: createRenderer try/catch -> Result.err(EngineEnvironmentError)
  //   (AC-01 / research section 2.2). createRenderer throws at
  //   createRenderer.ts:400 / :429 (rhi pack load failure /
  //   all WebGPU channels unavailable); we forward the original
  //   EngineEnvironmentError instance verbatim to preserve the
  //   .detail.webgpuError surface. RhiError instances raised mid-
  //   construction are also forwarded -- the AppError | RhiError leg of
  //   the union covers them. Any other unexpected throw is also
  //   forwarded to keep the contract honest (AI users walk the union
  //   discriminant rather than parse error.message strings).
  // feat-20260608 / M2 / D-3: CreateAppOptions stops `extends RendererOptions`,
  // so the two RHI escape hatches (rhi / rawDeviceForContextConfigure) are
  // forwarded explicitly. Build a RendererOptions object out of just those
  // fields when present; an empty {} keeps createRenderer on its default path.
  const rendererOpts: import('@forgeax/engine-runtime').RendererOptions = {};
  if (opts?.rhi !== undefined) {
    Object.assign(rendererOpts, { rhi: opts.rhi });
  }
  if (opts?.rawDeviceForContextConfigure !== undefined) {
    Object.assign(rendererOpts, {
      rawDeviceForContextConfigure: opts.rawDeviceForContextConfigure,
    });
  }

  // m3-1: FORGEAX_ENGINE_RHI_DEBUG=1 RHI-debug recorder wiring.
  // When FORGEAX_ENGINE_RHI_DEBUG=1, wrap the RHI instance and createShaderModule
  // function before createRenderer so the proxy chain intercepts all
  // adapter/device/shader calls. The wrap happens BEFORE createRenderer;
  // _onFrameEnd hookup happens AFTER (needs the renderer object).
  let _debugInst: DebugRhiInstance | undefined;
  // Read FORGEAX_ENGINE_RHI_DEBUG from two sources (plan-strategy D-4):
  //   - browser: import.meta.env, statically replaced by the
  //     vite-plugin-rhi-debug `define` hook. The `typeof import.meta !==
  //     'undefined'` prefix short-circuits under dawn-node, where import.meta
  //     itself can be undefined (C5).
  //   - dawn-node: globalThis.process.env (no vite define on the native path).
  // resolveRhiDebugFlag (internal/rhi-debug-flag) is the SSOT for the `??`
  // precedence; the source bags are computed inline here so the
  // typeof-import.meta prefix stays at the call site. Keeps this file
  // @types/node-free (engine-app ships ESM into both browser + dawn-node;
  // same pattern as runtime/src/render-system-record.ts:isMeshSsboDevMode).
  const importMetaEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { FORGEAX_ENGINE_RHI_DEBUG?: string } }).env
      : undefined;
  const processEnv = (globalThis as { process?: { env?: { FORGEAX_ENGINE_RHI_DEBUG?: string } } })
    .process?.env;
  const rhiDebugFlag = resolveRhiDebugFlag(importMetaEnv, processEnv);
  if (rhiDebugFlag === '1') {
    // Select backend: same auto-detect logic as createRenderer's loadBackendPack.
    const nav: { gpu?: unknown } | undefined =
      typeof globalThis !== 'undefined'
        ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
        : undefined;
    const hasWebGPU = nav !== undefined && 'gpu' in nav && nav.gpu !== undefined;

    let realBackend: Record<string, unknown>;
    // Literal import specifiers per branch (not a computed `backendPkg`
    // variable). vite's import-analysis can only resolve a string-literal
    // specifier to a served module URL; a variable specifier left
    // `globalThis.__forgeax.captureFrame` unreachable in the browser dev path
    // (`Failed to resolve module specifier '@forgeax/engine-rhi-webgpu'`).
    // Mirrors createRenderer's loadBackendPack (static rhiWebgpu namespace +
    // literal `import('@forgeax/engine-rhi-wgpu')`). NO @vite-ignore here: vite
    // must transform the literal so the browser receives a resolvable URL; the
    // consuming demo declares both backend packages as deps. dawn-node (no vite)
    // runs the literal through the node ESM resolver unchanged. Surfaced by the
    // hello-cube RHI-debug browser e2e (feat-20260617 M4 / w22), the first
    // FORGEAX_ENGINE_RHI_DEBUG=1 browser run through this guard.
    realBackend = (hasWebGPU
      ? await import('@forgeax/engine-rhi-webgpu')
      : await import('@forgeax/engine-rhi-wgpu')) as unknown as Record<string, unknown>;
    // rhi-wgpu requires wasm initialisation before use.
    if (!hasWebGPU && 'ensureReady' in realBackend) {
      await (realBackend.ensureReady as () => Promise<unknown>)();
    }

    const { wrap, wrapCreateShaderModule } = await import(
      /* @vite-ignore */ '@forgeax/engine-rhi-debug'
    );

    const realRhi = realBackend.rhi as RhiInstance;
    const debugInst = wrap(realRhi);
    _debugInst = debugInst;

    // Attach extras from the real backend so Channel-1 probe in
    // loadBackendPack picks them up (createShaderModule /
    // translateErrorEventToRhiError / _internal_getRawDevice).
    const extras = debugInst as unknown as Record<string, unknown>;
    if ('createShaderModule' in realBackend && realBackend.createShaderModule) {
      const realCsm = realBackend.createShaderModule as CreateShaderModuleFn;
      extras.createShaderModule = wrapCreateShaderModule(realCsm, debugInst);
    }
    if ('translateErrorEventToRhiError' in realBackend) {
      extras.translateErrorEventToRhiError = realBackend.translateErrorEventToRhiError;
    }
    if ('_internal_getRawDevice' in realBackend) {
      extras._internal_getRawDevice = realBackend._internal_getRawDevice;
    }
    // Forward acquireCanvasContext: createRenderer's Channel-1 escape hatch
    // calls `pack.rhi.acquireCanvasContext(canvas)` (createRenderer.ts:711), but
    // recorder.wrap() returns an explicit debug surface that does NOT carry it,
    // so without this the wrapped-rhi injection threw a TypeError ("engine init
    // failed (TypeError)") before any frame rendered -- the
    // FORGEAX_ENGINE_RHI_DEBUG=1 browser path was never exercised end-to-end
    // before the hello-cube RHI-debug browser e2e (feat-20260617 M4 / w22).
    // acquireCanvasContext only calls canvas.getContext('webgpu') (no recorded
    // RHI calls), so forwarding the real instance's bound method is safe and
    // keeps the recorder proxy out of the swap-chain config path.
    // The forwarded context's `configure({ device })` reverse-looks-up the raw
    // GPUDevice in rhi-webgpu's RAW_DEVICE_MAP keyed on the RhiDevice that
    // makeRhiDevice registered. The renderer threads the proxied device (from
    // the requestAdapter -> requestDevice proxy chain) here, which is a
    // different JS object -> the lookup misses and configure returns
    // rhi-not-available ("CanvasConfiguration.device must be a RhiDevice
    // produced by ..."). Unwrap the proxy to the registered device via the
    // _realDevice escape hatch (same fix as wrapCreateShaderModule).
    const realRhiRec = realRhi as unknown as Record<string, unknown>;
    if (typeof realRhiRec.acquireCanvasContext === 'function') {
      const boundAcquire = (realRhiRec.acquireCanvasContext as (c: unknown) => unknown).bind(
        realRhi,
      );
      extras.acquireCanvasContext = (canvasArg: unknown): unknown => {
        const ctxRes = boundAcquire(canvasArg) as {
          ok: boolean;
          value?: { configure(desc: Record<string, unknown>): unknown };
        };
        if (!ctxRes.ok || ctxRes.value === undefined) return ctxRes;
        const realCtx = ctxRes.value;
        const wrappedCtx: Record<string, unknown> = Object.create(realCtx as object);
        wrappedCtx.configure = (desc: Record<string, unknown>): unknown => {
          const dev = desc.device as { _realDevice?: unknown } | undefined;
          const realDevice = dev?._realDevice;
          const unwrapped = realDevice !== undefined ? { ...desc, device: realDevice } : desc;
          return realCtx.configure(unwrapped);
        };
        return { ...ctxRes, value: wrappedCtx };
      };
    }

    // Inject the wrapped RHI instance via the explicit rhi escape hatch.
    // createRenderer's Channel 1 uses it verbatim; the proxied
    // requestAdapter -> requestDevice chain intercepts all device calls.
    Object.assign(rendererOpts, { rhi: debugInst as RhiInstance });

    // w18: expose globalThis.__forgeax.captureFrame for the DevTools trigger
    // (OOS-1/2: DevTools-only). The capture-browser subpath is imported
    // dynamically so the FORGEAX_ENGINE_RHI_DEBUG=0 tree-shake gate stays
    // intact (AC-03/AC-10) -- it is reached only when the flag is '1'. When the
    // flag is unset this assignment never runs, so globalThis.__forgeax does
    // not exist and a DevTools caller hits a TypeError (charter P3 explicit
    // failure -- F-3 zero-injection).
    (globalThis as { __forgeax?: { captureFrame(n: number): Promise<unknown> } }).__forgeax = {
      captureFrame(n: number): Promise<unknown> {
        return import('@forgeax/engine-rhi-debug/capture-browser').then((m) =>
          m.captureAndUpload(debugInst, n),
        );
      },
    };

    // M2 / t7 (W3): register HMR listener for external CLI trigger.
    // The vite-plugin-rhi-debug trigger middleware broadcasts
    // 'forgeax-debug:capture' custom events via server.ws.send; this
    // handler receives them and calls captureAndUpload directly (three
    // args: debugInst, frames, label) rather than the DevTools
    // globalThis.__forgeax.captureFrame (which only takes n, losing
    // the label). Dynamic import mirrors the globalThis pattern above
    // so the FORGEAX_ENGINE_RHI_DEBUG=0 tree-shake gate stays intact.
    // prod: import.meta.hot -> undefined -> entire block DCE'd;
    // dawn-node: import.meta.hot undefined, guard short-circuits.
    // research Finding 2: cb is single-param payload (NOT double-param).
    // plan-strategy D-5: handler calls captureAndUpload directly.
    //
    // The handler registration is extracted into
    // internal/hmr-capture-listener.ts so the test (create-app-hmr.test.ts)
    // shares the SSR handler, not a copied shadow (per PR1
    // resolveRhiDebugFlag SSOT pattern).
    const hotMeta = import.meta as {
      hot?: { on(event: string, cb: (payload: { frames?: number; label?: string }) => void): void };
    };
    if (hotMeta.hot) {
      registerCaptureHmrListener(hotMeta.hot, debugInst);
    }
  }

  let renderer: Renderer;
  try {
    renderer = await createRenderer(canvas, rendererOpts, bundler);
  } catch (e: unknown) {
    if (e instanceof EngineEnvironmentError) {
      return err(e);
    }
    // Unknown throw shapes (RhiError surfaced as throw, raw Error, ...).
    // Re-raise to preserve fail-fast: the contract pins
    // EngineEnvironmentError as the only construction-time failure
    // shape; anything else is an engine bug, not an app-shell concern.
    throw e;
  }

  // m3-1 (continued): hook up _onFrameEnd after createRenderer returns.
  // The recorder receives frame-completion callbacks to inject frameMark
  // events. Only wired when FORGEAX_ENGINE_RHI_DEBUG=1.
  let _debugAdapter: unknown | undefined;
  if (_debugInst !== undefined) {
    const r = renderer as Renderer & {
      _onFrameEnd(listener: () => void): () => void;
    };
    r._onFrameEnd(() => {
      _debugInst.onFrameEnd();
    });

    // I-2 fix (round 1 implement-review): construct the production
    // DebugRhiAdapter so AC-18 / AC-19 / AC-20 RPC routes have a real
    // implementation behind them. Imports the adapter subpath
    // (`@forgeax/engine-rhi-debug/adapter`) dynamically so the FORGEAX_ENGINE_RHI_DEBUG=0
    // tree-shake gate stays intact (AC-03). The adapter needs the live
    // RhiDevice that the renderer drives — the recorder already
    // captured it on the requestAdapter().requestDevice() proxy chain.
    const debugInstWithDevice = _debugInst as DebugRhiInstance & {
      _getCapturedDevice(): unknown;
    };
    const capturedDevice = debugInstWithDevice._getCapturedDevice();
    if (capturedDevice !== undefined) {
      const adapterMod = (await import(
        /* @vite-ignore */ '@forgeax/engine-rhi-debug/adapter'
      )) as unknown as {
        createDebugRhiAdapter: (args: { debugInst: DebugRhiInstance; device: unknown }) => unknown;
      };
      _debugAdapter = adapterMod.createDebugRhiAdapter({
        debugInst: _debugInst,
        // biome-ignore lint/suspicious/noExplicitAny: RhiDevice opaque branded type round-trips through unknown
        device: capturedDevice as any,
      });
    }
  }

  // Step 2.4 decision: resolve whether the remote eval server should start
  // (feat-20260629-inspector-two-layer-model M4 / w20). Dual-source gating
  // mirrors the rhi-debug-flag pattern. The actual startServer call is
  // deferred to after World creation (Step 3) because the server needs
  // a live World reference.
  const shouldStartRemote = resolveRemoteServeFlag(
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { DEV?: boolean } }).env?.DEV
      : undefined,
    (globalThis as { process?: { env?: { FORGEAX_ENGINE_REMOTE_SERVE?: string } } }).process?.env,
  );

  // Step 2.5: debug-draw auto-attach (feat-20260615 M5 / w31).
  // Fire-and-forget: createDebugDrawOnReady awaits renderer.ready
  // internally and registers the instance for graph pass closures.
  // In non-debug-draw apps this dynamic import will fail gracefully
  // (the render-graph pass is a silent no-op when no DebugDraw is
  // registered). We create it here so app.debugDraw is populated
  // before the first frame.
  let debugDraw: DebugDraw | undefined;
  try {
    debugDraw = await createDebugDrawOnReady(renderer);
  } catch (_e) {
    // DebugDraw creation failed — e.g. shader module compilation
    // failed. The app continues without debug overlay; the error
    // is surfaced via renderer.onError (createDebugDrawOnReady
    // throws on creation failure, and the renderer's error registry
    // has already captured it).
  }

  // Step 3: new World() -- the canvas form owns world lifetime, in
  // contrast to the assemble form where the host owns it.
  const world = new World();

  // Step 3.1 (M2 plugin-system-unify / D-4): app-layer side effects that the
  // plugins consume via pre-injected world resources.
  //
  // NOTE: AnimationAssetResolver is NO LONGER inserted here — animationPlugin()
  // (in the defaultSet below, and in every assemble-form host's plugin list) now
  // self-owns it in build(), the same way physicsPlugin/statePlugin own their
  // resources. This collapses the canvas-vs-assemble divergence that crashed the
  // editor ▶ Play fork ("Required resource 'AnimationAssetResolver' not found"):
  // the sole owner is the plugin, so both createApp forms are correct for free.
  // transform + animation system registration lives in the plugins (default set).

  // Input DOM attach (D-3 / C-5): attachBrowserInputBackend needs the canvas
  // (a DOM surface only this path knows about), so the app attaches it and
  // inserts the backend as the INPUT_BACKEND_KEY world resource. inputPlugin
  // (default set) then registers the frame-start scan system, guarded by the
  // resource presence. The cleanup funnel (detach + removeSystem) stays bound
  // to stop / device-lost in the app layer (the plugin cannot own DOM
  // lifetime). M3 (w15): input:false opt-out deleted — canvas form always
  // attaches input; hosts that want to opt out use assemble form (D-6).
  const inputHandle = attachInputAuto(canvas, world, {
    ...(opts?.pointerLockAllowed ? { pointerLockAllowed: opts.pointerLockAllowed } : {}),
    ...(opts?.virtualJoysticks ? { virtualJoysticks: opts.virtualJoysticks } : {}),
    ...(opts?.inputMap ? { inputMap: opts.inputMap } : {}),
    ...(opts?.lockProvider ? { lockProvider: opts.lockProvider } : {}),
  });

  // Audio backend (D-4): auto-create the WebAudioBackend when the user listed
  // audioPlugin() in plugins[]. This preserves the M2 contract (audioPlugin
  // only does world-registration; the backend lifecycle stays in the app layer).
  // M3 (w15): opts.audio flag deleted — detection is by plugin name.
  let audioBackend: AudioBackend | undefined;
  const userPlugins: Plugin[] = [...(opts?.plugins ?? [])];
  const hasAudioPlugin = userPlugins.some((p) => p.name === 'audio');
  if (hasAudioPlugin) {
    audioBackend = createWebAudioBackend();
    world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, audioBackend);
  }

  // Step 3.2 (D-2): canvas form runs the full 5-plugin default set merged with
  // the user plugins. runPlugins is awaited BEFORE buildApp so a duplicate-plugin /
  // plugin-build-failed surfaces as Result.err before the frame loop is armed,
  // and so a physics WASM load completes before createApp resolves (AC-06: no
  // post-resolve timing gap). M3 (w15): legacy opts.physics / opts.audio bridges
  // deleted -- demos pass plugins directly; audio backend is auto-created above
  // when audioPlugin is detected in userPlugins.
  const defaultSet: Plugin[] = [
    transformPlugin(),
    timePlugin(),
    animationPlugin(),
    statePlugin(),
    inputPlugin(),
  ];
  const pluginResult = await runPlugins(world, defaultSet, userPlugins);
  if (!pluginResult.ok) {
    return err(pluginResult.error);
  }

  // Step 3.3: Remote eval server auto-start (deferred from Step 2.4 so
  // World is available). Dynamic import keeps @forgeax/engine-app free
  // of static dep on @forgeax/engine-remote.
  let remoteHandle: { readonly port: number; close(): Promise<void> } | undefined;
  if (shouldStartRemote) {
    try {
      const remoteServerMod = (await import(
        /* @vite-ignore */ '@forgeax/engine-remote/server'
      )) as unknown as {
        startServer: (opts: {
          port: number;
          host?: string;
          world: unknown;
          renderer?: unknown;
          assets?: unknown;
          debugAdapter?: unknown;
        }) => Promise<{
          ok: boolean;
          value?: { port: number; close(): Promise<void> };
          error?: { code: string };
        }>;
      };
      const serverResult = await remoteServerMod.startServer({
        port: 0, // OS-assigned ephemeral port
        host: '127.0.0.1',
        world,
        renderer,
        assets: renderer.assets,
        ...(_debugAdapter !== undefined ? { debugAdapter: _debugAdapter } : {}),
      });
      if (serverResult.ok && serverResult.value) {
        remoteHandle = { port: serverResult.value.port, close: serverResult.value.close };
      }
    } catch (_e) {
      // Dynamic import or server start failed — app continues without remote.
      // The error is logged by startServer internally.
    }
  }

  const buildArgs: BuildAppArgs = {
    renderer,
    world,
    pluginRegistry: pluginResult.value,
    inputBackend: inputHandle.backend,
    cleanup: (onErrorDispatch: (err: AppError) => void) => {
      inputHandle.cleanup({ onError: onErrorDispatch });
    },
    // M2 D-4: wire the input handle's setOnErrorDispatch so that onLockError
    // signals from the backend reach the buildApp error fan-out. The dispatch
    // function is created inside buildApp (after the ErrorFanoutRegistry is
    // set up), so we use a callback to bridge the gap.
    wireOnLockErrorDispatch: (dispatch: (err: AppError) => void) => {
      inputHandle.setOnErrorDispatch(dispatch);
    },
  };
  if (audioBackend !== undefined) {
    Object.assign(buildArgs, {
      audioBackend,
      audioBackendDispose: () => {
        audioBackend.destroy();
      },
    });
  }
  if (opts?.maxDt !== undefined) {
    Object.assign(buildArgs, { maxDt: opts.maxDt });
  }
  if (opts?.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: opts.silenceUnhandledErrors });
  }
  // M2 / D-3: canvas form forwards the host-supplied draw-source pull.
  if (opts?.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: opts.drawSource });
  }
  if (_debugInst !== undefined) {
    Object.assign(buildArgs, { debugRhi: _debugInst });
  }
  if (_debugAdapter !== undefined) {
    Object.assign(buildArgs, { debugAdapter: _debugAdapter });
  }
  if (debugDraw !== undefined) {
    Object.assign(buildArgs, { debugDraw });
  }
  if (remoteHandle !== undefined) {
    Object.assign(buildArgs, { remoteHandle });
  }

  // feat-20260617-host-engine-contract-and-video-cutscene / M3 / w13 + D-6:
  // the aspect-sync sidecar lives ONLY on the createApp(canvas) path -- the
  // canvas is the host-owned DOM surface this path knows about, and the bare
  // createRenderer / assemble paths intentionally never receive it (host-engine
  // contract clause #3 / OOS-9). Registered through app.registerUpdate (the
  // public per-frame seam) so buildApp's signature stays untouched. The
  // closure captures the live canvas; syncCameraAspect reads its
  // width / height each frame and writes Camera.aspect for perspective +
  // autoAspect=true cameras (D-5: world.get, not the query bundle).
  const built = await buildApp(buildArgs);
  if (built.ok) {
    built.value.registerUpdate(() => {
      syncCameraAspect(world, canvas.width, canvas.height);
    });

    // feat-20260619 M7: auto-register audio listener-sync system (D-7).
    // Runs as an ECS addSystem (after propagateTransforms) — NOT via
    // registerUpdate — so it reads the CURRENT frame's Transform.world
    // mat4, not the previous frame. The audioTickSystem (D-2) has no
    // frame-order constraint and uses registerUpdate; listener sync
    // MUST use the ECS DAG seam because Transform.world is written by
    // propagateTransforms inside world.update().
    //
    // The closure lives in the app layer (D-8): audio-webaudio has no
    // dependency on runtime, so the query+world.get path must be
    // constructed where both packages are visible. Only canvas-form
    // apps receive this system (assemble form hosts manage their own
    // sync). The queryRun/bundle pattern follows syncCameraAspect's
    // structure (create-app.ts:524-538).
    if (audioBackend !== undefined && audioBackend instanceof WebAudioEngine) {
      const backend = audioBackend;
      world.addSystem({
        name: 'audio-listener-sync',
        after: [PROPAGATE_TRANSFORMS_SYSTEM],
        queries: [],
        fn: () => {
          const query = createQueryState({ with: [AudioListener, Entity] });
          queryRun(query, world, (bundle) => {
            const entitySelf = bundle.Entity.self;
            for (let i = 0; i < entitySelf.length; i++) {
              const entity = (entitySelf[i] ?? 0) as EntityHandle;
              const tf = world.get(entity, Transform);
              if (!tf.ok) continue;
              // backend.listener is a lazy getter that builds the AudioContext
              // on first access (ensureContext -> new AudioContext). Touch it
              // ONLY when an AudioListener entity actually exists, so a
              // headless host (dawn-node smoke: AudioEngine resource present
              // but no AudioListener entity, no AudioContext global) never
              // forces context creation and crashes.
              const listener = backend.listener;
              if (listener === undefined) break;
              syncListenerFromWorldMatrix(listener, tf.value.world);
              break;
            }
          });
        },
      });
    }
  }
  return built;
}

/**
 * Per-frame aspect-sync body for the createApp(canvas) path (feat-20260617
 * M3 / w13). Walks every Camera entity and, for perspective cameras with
 * `autoAspect === true`, writes `canvasW / canvasH` into `Camera.aspect`.
 *
 * Read discipline (D-5 / research Finding 2): `autoAspect` is read through
 * `world.get` (the readRow path narrows the bool column to a JS boolean).
 * The query bundle is used only to enumerate the entity handles -- reading
 * the bool column off the bundle would return a raw 0/1 number, so a
 * `!== 0` test is always true (the
 * bool-field-compared-with-not-equal-zero-always-true trap).
 *
 * Best-effort + side-effect-isolated:
 *   - canvas size 0 (detached / display:none) -> skip entirely so `aspect`
 *     never becomes NaN / 0.
 *   - orthographic cameras and `autoAspect === false` cameras are left
 *     untouched.
 *
 * @see {@link https://github.com/Forgeax/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 */
export function syncCameraAspect(world: World, canvasW: number, canvasH: number): void {
  // Guard against detached / zero-sized canvases: a 0 width or height would
  // write NaN (0 / 0) or 0 into aspect and corrupt the projection matrix.
  if (canvasW <= 0 || canvasH <= 0) return;
  const aspect = canvasW / canvasH;

  const query = createQueryState({ with: [Camera, Entity] });
  queryRun(query, world, (bundle) => {
    const entitySelf = bundle.Entity.self;
    for (let i = 0; i < entitySelf.length; i++) {
      const entity = (entitySelf[i] ?? 0) as EntityHandle;
      const r = world.get(entity, Camera);
      if (!r.ok) continue;
      // world.get narrows the bool column to a real boolean (D-5); the
      // perspective discriminator is the numeric column value.
      if (r.value.autoAspect !== true) continue;
      if (r.value.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
      world.set(entity, Camera, { aspect });
    }
  });
}

async function createAppFromAssemble(
  args: AppAssembleArgs,
): Promise<Result<App, AssembleAppError>> {
  // Host-owned renderer / world. The assemble form does NOT auto-create any
  // backend -- the host manages backend lifecycle (D-2).
  //
  // M2 plugin-system-unify / D-2: the assemble form runs ONLY the user plugins
  // (defaultSet=[]) against the host-owned world. The host manages its own
  // core wiring + backend resources (transform / state / audio / input etc.),
  // so this form never auto-injects the default 5 plugins -- preserving the
  // assemble-form byte-identity contract (R2).
  //
  // M3 (w15): args.input / args.audio deleted. The host pre-injects backends
  // via world.insertResource before calling createApp; App.input / App.audio
  // read back from world resources (buildApp).
  const pluginResult = await runPlugins(args.world, [], args.plugins ?? []);
  if (!pluginResult.ok) {
    return err(pluginResult.error);
  }

  const buildArgs: BuildAppArgs = {
    renderer: args.renderer,
    world: args.world,
    pluginRegistry: pluginResult.value,
  };

  // M3 (w15): read pre-injected backends from world resources. The host
  // pre-injected INPUT_BACKEND_KEY / AUDIO_ENGINE_RESOURCE_KEY before calling
  // createApp; their corresponding plugins (inputPlugin / audioPlugin) registered
  // the ECS systems because they found the resources.
  if (args.world.hasResource(INPUT_BACKEND_KEY)) {
    Object.assign(buildArgs, {
      inputBackend: args.world.getResource<InputBackend>(INPUT_BACKEND_KEY),
    });
  }
  if (args.world.hasResource(AUDIO_ENGINE_RESOURCE_KEY)) {
    Object.assign(buildArgs, {
      audioBackend: args.world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY),
    });
  }
  if (args.maxDt !== undefined) {
    Object.assign(buildArgs, { maxDt: args.maxDt });
  }
  if (args.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: args.silenceUnhandledErrors });
  }
  // M2 / D-3: assemble form forwards the host-supplied draw-source pull.
  if (args.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: args.drawSource });
  }
  return buildApp(buildArgs);
}

interface BuildAppArgs {
  readonly renderer: Renderer;
  readonly world: World;
  /** Plugin registry from runPlugins -- exposed on App.pluginRegistry for inspector consumption. */
  readonly pluginRegistry: Map<string, Plugin>;
  readonly inputBackend?: InputBackend;
  /**
   * M2 D-4: callback that buildApp calls after creating the ErrorFanoutRegistry
   * dispatch function. The input handle's onLockError callback needs the dispatch
   * function to fan out 'app-pointer-lock-failed' errors, but the dispatch function
   * is created inside buildApp (after the input handle is already constructed).
   * This callback bridges the gap.
   */
  readonly wireOnLockErrorDispatch?: (dispatch: (err: AppError) => void) => void;
  readonly audioBackend?: AudioBackend;
  readonly cleanup?: (onErrorDispatch: (err: AppError) => void) => void;
  readonly maxDt?: number;
  readonly silenceUnhandledErrors?: boolean;
  /**
   * feat-20260619-audio-resource-ownership-deterministic-reclaim / M1 / F23:
   * canvas form wraps createWebAudioBackend().destroy() into this callback
   * so app.stop() chains into WebAudioEngine.destroy(); assemble form
   * intentionally does NOT set it (host owns backend lifecycle, OOS-5).
   * Parallel pattern to cleanup (input auto-detach).
   */
  readonly audioBackendDispose?: () => void;
  /** I-2: live FORGEAX_ENGINE_RHI_DEBUG=1 recorder proxy from createAppFromCanvas. */
  readonly debugRhi?: DebugRhiInstance;
  /** I-2: production DebugRhiAdapter wired to the recorder + replay device. */
  readonly debugAdapter?: unknown;
  /** feat-20260615 debug-draw M5: DebugDraw instance created by createDebugDrawOnReady. */
  readonly debugDraw?: DebugDraw;
  /** feat-20260629 M4 / w20: remote eval server handle from createAppFromCanvas. */
  readonly remoteHandle?: { readonly port: number; close(): Promise<void> };
  /**
   * feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3:
   * per-frame draw-source pull forwarded verbatim into the frame-loop. Absent =>
   * legacy single-world path. Both createApp forms (canvas + assemble) forward
   * it from their respective options object.
   */
  readonly drawSource?: () =>
    | {
        worlds: readonly import('@forgeax/engine-ecs').World[];
        cameraOwner: number;
        resourceOwner: number;
      }
    | undefined;
}

/**
 * Internal builder shared by both overloads. Wires the frame-loop +
 * listener-registry onError + cleanup funnel; returns the App handle.
 *
 * The cleanup() callback (when provided) is invoked from inside stop()
 * so the auto-attach handle's detach + removeSystem run in the same
 * critical section as the frame-loop transition into 'idle'. Failures
 * are forwarded into the same listener registry (AC-05 / D-4).
 */
async function buildApp(args: BuildAppArgs): Promise<Result<App, AppError | RhiError>> {
  const {
    renderer,
    world,
    inputBackend,
    audioBackend,
    cleanup,
    audioBackendDispose,
    maxDt,
    silenceUnhandledErrors,
    debugRhi,
    debugAdapter,
    debugDraw,
    remoteHandle,
  } = args;

  // M2 plugin-system-unify (D-1 / D-4): audio resource injection,
  // state-machine wiring, and physics WASM load all moved into their plugins
  // (audioPlugin / statePlugin / physicsPlugin), run by runPlugins BEFORE this
  // builder. buildApp no longer wires any capability directly -- it only
  // injects the AssetRegistry resource (a renderer-derived resource, not a
  // plugin concern), builds the frame loop, and returns the App handle.

  // Inject renderer.assets as World Resource so the audio tick system's
  // createClipResolver can resolve clip handles -> AudioBuffer (D-1). This is a
  // renderer-derived resource (not a plugin), so it stays in the builder.
  if (renderer.assets !== undefined) {
    world.insertResource(ASSET_REGISTRY_RESOURCE_KEY, renderer.assets);
  }

  // physics resolver for app.physics (D-5): physicsPlugin inserts the
  // 'PhysicsWorld' world resource on a successful build, so app.physics reads
  // it back from the world rather than holding a private mutable slot. Because
  // runPlugins is awaited before buildApp, the resource is already present when
  // the getter is first read (AC-06: no post-resolve timing gap).
  function readPhysicsWorld():
    | import('@forgeax/engine-physics').PhysicsWorld
    | import('@forgeax/engine-physics').PhysicsWorld2D
    | undefined {
    if (!world.hasResource('PhysicsWorld')) return undefined;
    return world.getResource<
      | import('@forgeax/engine-physics').PhysicsWorld
      | import('@forgeax/engine-physics').PhysicsWorld2D
    >('PhysicsWorld');
  }
  // M4 (w11): listener registry replaces the M3 inline Set so console.error
  // fallback + duplicate-add no-op + unsubscribe handle behaviour matches
  // packages/runtime/src/createRenderer.ts:532-566 LostListenerRegistry
  // (plan-strategy D-9). silenceUnhandledErrors threads through verbatim.
  const fanout = new ErrorFanoutRegistry(
    silenceUnhandledErrors !== undefined ? { silenceUnhandledErrors } : {},
  );

  function dispatch(e: AppDispatchError): void {
    fanout.fire(e);
  }

  // M2 D-4: wire the input handle's onLockError callback to the error fan-out.
  // The dispatch function is created here; the input handle was created earlier
  // in createAppFromCanvas and passed to buildApp with a wireOnLockErrorDispatch
  // callback that calls setOnErrorDispatch on the handle.
  if (args.wireOnLockErrorDispatch) {
    args.wireOnLockErrorDispatch(dispatch);
  }

  const loopOpts: Parameters<typeof createFrameLoop>[0] = {
    world,
    renderer,
    onError: dispatch,
  };
  if (maxDt !== undefined) {
    Object.assign(loopOpts, { maxDt });
  }
  // M2 / D-3: forward the optional draw-source pull into the frame-loop. Absent
  // => the loop keeps the legacy single-world draw path.
  if (args.drawSource !== undefined) {
    Object.assign(loopOpts, { drawSource: args.drawSource });
  }
  const loop = createFrameLoop(loopOpts);

  // M4 (w13): triple-funnel cleanup (R-4 / D-2). stop / device-lost /
  // exception throw all converge here. lastError is a single mutable
  // slot so app.lastError reads the most-recent signal even when the
  // host did not register an onError listener (charter P3 explicit
  // failure: silent device-lost is unacceptable).
  let lastError: AppDispatchError | undefined;
  const cleanupFunnel = makeCleanupFunnel({
    loop,
    ...(cleanup !== undefined ? { inputCleanup: cleanup } : {}),
    dispatch,
    setLastError: (e) => {
      lastError = e;
    },
    // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M6 /
    // AC-08: stop-reason path chains into the M5 Renderer.dispose()
    // 6-step cascade (createRenderer.ts:1774). The funnel's `invoked`
    // latch + Renderer.dispose's own latch make double-stop a no-op.
    rendererDispose: () => {
      renderer.dispose();
    },
    // feat-20260619-audio-resource-ownership-deterministic-reclaim / M1 /
    // F23: canvas form wraps createWebAudioBackend().destroy() into
    // audioBackendDispose; assemble form does NOT pass this (host owns
    // backend lifecycle, OOS-5). Same shape as rendererDispose.
    ...(audioBackendDispose !== undefined ? { audioBackendDispose } : {}),
  });

  // M4 (w13) device-lost internal subscription. R-1 timing contract:
  // app.start() arms the rAF handle BEFORE this listener subscribes, so
  // a synchronous late-attach replay of a persisted device-lost event
  // (LostListenerRegistry replay -- runtime/src/renderer.ts:337-345)
  // hits a frame-loop with a real rAF handle to cancel (M2 setStopped
  // tolerates pendingFrameId === 0 as a no-op so even pre-rAF replays
  // do not NPE). The subscription remains active across pause / resume;
  // unsubscribe runs only on stop / device-lost cleanup (charter P3:
  // device-lost is a terminal lifecycle signal, not a transient blip).
  let rendererUnsubscribe: (() => void) | undefined;

  function subscribeRendererErrors(): void {
    if (rendererUnsubscribe !== undefined) {
      return;
    }
    rendererUnsubscribe = renderer.onError((e: RendererError) => {
      // D-3: device-lost stays in RhiError 18-member union; AppError does
      // NOT add 'app-device-lost'. The host onError listener receives the
      // error verbatim through the fanout dispatch below.
      //
      // feat-20260531-skybox-env-background F-1: the renderer onError channel
      // now fans out RhiError | RuntimeError (e.g. 'equirect-projection-failed');
      // only the RhiError 'device-lost' arm triggers the cleanup funnel, every
      // other code (RHI or runtime) flows through to the host fan-out.
      //
      // Note: we discriminate by .code rather than instanceof RhiError
      // because the listener may be invoked across module boundaries
      // (re-export from @forgeax/engine-runtime vs direct
      // @forgeax/engine-rhi/errors import). Bundler dedup is not
      // guaranteed on subpath exports, so an instanceof check is a
      // false-negative trap. The union .code type still provides static
      // safety on .code access.
      if (e?.code === 'device-lost') {
        cleanupFunnel({ reason: 'device-lost', lastError: e });
      }
      // Always fan out to host listeners (D-2 last bullet: device-lost
      // error is forwarded as-is to host onError listener so the host
      // can decide whether to rebuild the renderer).
      dispatch(e);
    });
  }

  function unsubscribeRendererErrors(): void {
    if (rendererUnsubscribe !== undefined) {
      rendererUnsubscribe();
      rendererUnsubscribe = undefined;
    }
  }

  const stub: App = {
    renderer,
    world,
    pluginRegistry: args.pluginRegistry,
    ...(inputBackend !== undefined ? { input: inputBackend } : {}),
    ...(audioBackend !== undefined ? { audio: audioBackend } : {}),
    get physics():
      | import('@forgeax/engine-physics').PhysicsWorld
      | import('@forgeax/engine-physics').PhysicsWorld2D
      | undefined {
      return readPhysicsWorld();
    },
    registerUpdate(fn: (dt: number) => void): void {
      loop.addUpdateCallback(fn);
    },
    start(): Result<void, AppError> {
      // R-1: arm the rAF handle FIRST (loop.start schedules raf(tick))
      // and only THEN subscribe to renderer.onError. If the renderer
      // late-attach replays a persisted device-lost event during the
      // subscribe call, the cleanup funnel finds a non-zero rafHandle
      // (or zero, which setStopped no-ops on) and there is no NPE.
      const r = loop.start();
      if (r.ok) {
        subscribeRendererErrors();
      }
      return r;
    },
    stop(): Result<void, AppError> {
      const r = loop.stop();
      // R-4 stop path: even if loop.stop returned err (e.g. paused state
      // or double-stop), input cleanup still runs (input-attach.ts:97-104
      // is idempotent). Unsubscribe the device-lost listener so a host
      // restart -- which will create a NEW App with a NEW listener -- is
      // not double-counted by the renderer's listener registry.
      cleanupFunnel({ reason: 'stop' });
      unsubscribeRendererErrors();
      return r;
    },
    pause(): Result<void, AppError> {
      return loop.pause();
    },
    resume(): Result<void, AppError> {
      return loop.resume();
    },
    onError(cb: (e: AppDispatchError) => void): () => void {
      return fanout.add(cb);
    },
    /**
     * Last error captured by the cleanup funnel. Useful for host
     * self-inspection on device-lost without requiring an onError
     * listener up-front (charter P3 explicit failure: AI users get the
     * latest signal; reading once is informative even when no listener
     * was registered).
     */
    get lastError(): AppDispatchError | undefined {
      return lastError;
    },
    // I-2 fix (round 1 implement-review): expose the live recorder
    // proxy + adapter so demo code can drive arm/finalize/inspect
    // without going through WS:5732. Both are undefined when
    // FORGEAX_ENGINE_RHI_DEBUG !== '1' (createAppFromCanvas only forwards them
    // through buildArgs when wrap was actually invoked).
    ...(debugRhi !== undefined ? { _debugRhi: debugRhi } : {}),
    ...(debugAdapter !== undefined ? { _debugAdapter: debugAdapter } : {}),
    ...(debugDraw !== undefined ? { debugDraw } : {}),
    ...(remoteHandle !== undefined ? { remote: remoteHandle } : {}),
  };

  // Readiness barrier (charter Fail Fast). createRenderer resolves before
  // its `ready` Promise (manifest -> pipeline -> asset upload three-step
  // chain) settles, so a host that calls app.start() immediately would arm
  // the rAF loop while renderer.draw(world) still returns 'rhi-not-available'
  // every frame -- a startup race that surfaces as intermittent console.error
  // spam on cold loads. Awaiting ready here makes "App ready" mean "renderer
  // ready": start() never observes a pre-ready frame, and a genuine pipeline
  // build failure fail-fasts as Result.err(rhiError) (caught by the canonical
  // `if (!app.ok) reportError(app.error)` takeoff) instead of per-frame noise.
  // M2 plugin-system-unify (D-1 / D-4): the audio tick system is now registered
  // by audioPlugin (run by runPlugins before buildApp) as the 'audio-tick'
  // world system, so there is no buildApp-side registerUpdate hook anymore.
  const readyResult = await renderer.ready;
  if (!readyResult.ok) {
    return err(readyResult.error);
  }

  return ok(stub);
}
