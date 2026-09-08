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

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AudioBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { RenderError } from '@forgeax/engine-render';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera, type Renderer } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  type CaptureFrameOptions,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import * as engineRuntimeModule from '@forgeax/engine-runtime';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import {
  constructRuntimeRendererHost,
  loadRhiPack,
} from '@forgeax/engine-runtime/internal/renderer-host';
import { err, ok, type Result } from '@forgeax/engine-types';

import { createAnimationPayloadLookup } from './animation-asset-lookup';
import { publishBrowserFrameSubmitted, resetBrowserFrameSubmitted } from './browser-frame-signal';
import type { AppErrorCode, AppErrorDetailFor } from './errors';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from './errors';
import {
  createExecutionReport,
  type ExecutionControl,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
  probeExecutionCapabilities,
  selectExecutionTier,
  unavailableExecutionCapabilities,
} from './execution';
import { normalizeExecutionBootstrapUrl } from './execution/bootstrap-url';
import { createLocalExecutionControl } from './execution/control';
import { createWorkerExecutionApp } from './execution/host-controller';
import { assembledEngineProfile } from './internal/assembled-engine-profile';
import { projectComponentIntrospection } from './internal/component-introspection';
import { ErrorFanoutRegistry } from './internal/error-fanout';
import { createFrameLoop } from './internal/frame-loop';
import { attachInputAuto } from './internal/input-attach';
import { mainEngineProfile } from './internal/main-engine-profile';
import { resolveRemoteServeFlag } from './internal/remote-serve-flag';
import { remoteServerPlugin } from './internal/remote-server-plugin';
import {
  bindRhiCaptureFrameDriver,
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
} from './internal/rhi-capture';
import { resolveRhiDebugFlag } from './internal/rhi-debug-flag';
import { createRenderFeatureHost, type RenderFeatureHost } from './renderer-plugin';
import type {
  App,
  AppAssembleArgs,
  AppDispatchError,
  AssembleAppError,
  BundlerOptions,
  CanvasAppError,
  CreateAppOptions,
  ExecutionApp,
} from './types';

function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

function canvasAspectPlugin(canvas: HTMLCanvasElement): Plugin {
  return {
    name: 'canvas-aspect',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        const system = {
          name: 'app-sync-camera-aspect',
          queries: [],
          fn: () => {
            syncCanvasDrawingBuffer(canvas);
            syncCameraAspect(ctx.world, canvas.width, canvas.height);
          },
        };
        ctx.world.addSystem(Update, system).unwrap();
        return () => ctx.world.removeSystem(Update, system.name).unwrap();
      }, 'app/canvas-aspect');
    },
  };
}

function rhiDebugHostPlugin(dispose: () => void): Plugin {
  return {
    name: 'rhi-debug-host',
    apply(ctx) {
      ctx.effect(() => dispose, 'rhi-debug/host');
    },
  };
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
 * M3 ships the path needed by AC-05 (auto input acquisition plus an ECS scan
 * plugin). M4 finalises the canvas-detached guard +
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
  opts: CreateAppOptions & { readonly execution: NonNullable<CreateAppOptions['execution']> },
  bundler?: BundlerOptions,
): Promise<Result<ExecutionApp, CanvasAppError>>;
export function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: BundlerOptions,
): Promise<Result<App, CanvasAppError>>;

/**
 * Create the browser host for the single RenderScene -> FrameReceipt path.
 * `createApp({ renderer, world, input?, schedule?, ... })` is the assemble form
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
): Promise<Result<App | ExecutionApp, CanvasAppError>> {
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
): Promise<Result<App | ExecutionApp, CanvasAppError>> {
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

  // The DOM canvas starts with a 300x150 drawing buffer even when CSS lays it
  // out at a different size. Set the physical buffer before the renderer
  // configures its swap chain; the same helper runs before each frame so a CSS
  // resize remains visible to both rendering and camera policy.
  syncCanvasDrawingBuffer(canvas);

  let executionBootstrapUrl: string | undefined;
  if (opts?.execution !== undefined) {
    const normalizedBootstrap = normalizeExecutionBootstrapUrl(opts.execution.bootstrap);
    if (!normalizedBootstrap.ok) return err(normalizedBootstrap.error);
    executionBootstrapUrl = normalizedBootstrap.value;
    const realmBoundOption = [
      ['features', opts.features],
      ['plugins', opts.plugins],
      ['rhi', opts.rhi],
      ['rhiInstrumentation', opts.rhiInstrumentation],
      ['drawSource', opts.drawSource],
      ['bundler.importTransport', bundler?.importTransport],
    ].find(([, value]) => value !== undefined)?.[0];
    if (realmBoundOption !== undefined) {
      return err(
        makeAppError(
          'app-execution-bootstrap-failed',
          APP_EXPECTED['app-execution-bootstrap-failed'],
          APP_ERROR_HINTS['app-execution-bootstrap-failed'],
          {
            phase: 'prepare',
            moduleUrl: executionBootstrapUrl,
            cause: new TypeError(
              `${realmBoundOption} must be constructed by the execution bootstrap module`,
            ),
          },
        ),
      );
    }
  }

  let executionContext:
    | {
        readonly capabilities: import('./execution').ExecutionCapabilities;
        readonly selection: import('./execution').ExecutionSelection;
      }
    | undefined;
  let preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined;
  if (opts?.execution !== undefined) {
    const capabilities = await probeExecutionCapabilities(canvas);
    const selected = selectExecutionTier({
      requestedTier: opts.execution.tier ?? 'auto',
      capabilities,
      sharedEvidencePassed: true,
    });
    if (!selected.ok) return err(selected.error);
    executionContext = { capabilities, selection: selected.value };
    if (selected.value.actualTier !== 'main-serial') {
      return createWorkerExecutionApp({
        canvas,
        appOptions: opts,
        syncCanvas: () => measureCanvasDrawingBuffer(canvas),
        ...(bundler !== undefined ? { bundler } : {}),
        capabilities,
        selection: selected.value,
      });
    }
    if (executionBootstrapUrl === undefined) {
      throw new Error('execution bootstrap URL was not normalized');
    }
    const prepared = await prepareBootstrapEntry(
      executionBootstrapUrl,
      opts.execution.bootstrapData,
    );
    if (!prepared.ok) return err(prepared.error);
    preparedExecutionBootstrap = prepared.value;
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
  // so the RHI escape hatch (rhi) is
  // forwarded explicitly. Build a RendererOptions object out of just those
  // fields when present; an empty {} keeps createRenderer on its default path.
  const rendererOpts: import('@forgeax/engine-render').RendererOptions = {};
  if (opts?.rhi !== undefined) {
    Object.assign(rendererOpts, { rhi: opts.rhi });
  }
  if (opts?.profiler !== undefined) {
    Object.assign(rendererOpts, { profiler: opts.profiler });
  }
  const rendererFeatures = preparedExecutionBootstrap?.features ?? opts?.features;
  if (rendererFeatures !== undefined) {
    Object.assign(rendererOpts, { features: rendererFeatures });
  }
  if (opts?.standardProfile !== undefined) {
    Object.assign(rendererOpts, { standardProfile: opts.standardProfile });
  }
  if (opts?.rhiInstrumentation !== undefined) {
    Object.assign(rendererOpts, { rhiInstrumentation: opts.rhiInstrumentation });
  }

  // FORGEAX_ENGINE_RHI_DEBUG=1 attaches the recorder at the Runtime backend
  // seam. Render remains the owner of device/surface lifecycle; App only owns
  // the optional capture capability and its frame transaction.
  let rhiAttachment: RecorderAttachment | undefined;
  let rhiCapture: RhiCapture | undefined;
  let rhiDebugGlobal:
    | { captureFrame(options?: CaptureFrameOptions): ReturnType<RhiCapture['captureFrame']> }
    | undefined;
  const cleanupRhiDebugHost = (): void => {
    const host = globalThis as { __forgeax?: typeof rhiDebugGlobal };
    if (host.__forgeax === rhiDebugGlobal) delete host.__forgeax;
    rhiDebugGlobal = undefined;
    const attachment = rhiAttachment;
    rhiAttachment = undefined;
    if (attachment !== undefined) void attachment.dispose();
  };
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
  // Keep the Vite define key in a direct property expression. Wrapping
  // `import.meta` in a structural cast hides the token from Vite's define
  // pass, so production builds retain the debug-only dynamic chunks even when
  // the Preview host explicitly sets the flag to `0`. Optional chaining keeps
  // the package safe on the Dawn/Node path where `import.meta.env` is absent.
  const importMetaEnv =
    typeof import.meta !== 'undefined'
      ? { FORGEAX_ENGINE_RHI_DEBUG: import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG }
      : undefined;
  // A browser production build must be able to erase the entire recorder
  // branch. The `undefined` arm preserves Dawn/Node's process.env fallback;
  // Vite replaces the direct property with `"0"` or `"1"`, making this outer
  // guard a literal false/true before Rollup sees the debug-only imports.
  const browserBuildRhiDebugFlag =
    typeof import.meta !== 'undefined' ? import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG : undefined;
  const processEnv = (globalThis as { process?: { env?: { FORGEAX_ENGINE_RHI_DEBUG?: string } } })
    .process?.env;
  const rhiDebugFlag = resolveRhiDebugFlag(importMetaEnv, processEnv);
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  const hasWebGPU = nav !== undefined && 'gpu' in nav && nav.gpu !== undefined;
  if (
    (browserBuildRhiDebugFlag === undefined || browserBuildRhiDebugFlag === '1') &&
    rhiDebugFlag === '1'
  ) {
    const realBackend = (hasWebGPU
      ? await import('@forgeax/engine-rhi-webgpu')
      : await import('@forgeax/engine-rhi-wgpu')) as unknown as Record<string, unknown>;
    if (!hasWebGPU && 'ensureReady' in realBackend) {
      await (realBackend.ensureReady as () => Promise<unknown>)();
    }
    const pack = loadRhiPack(realBackend);
    if (pack.createShaderModule === undefined) {
      throw new Error('RHI-debug requires a backend createShaderModule capability');
    }
    const attached = attachRecorder({
      rhi: pack.rhi,
      createShaderModule: pack.createShaderModule,
    });
    if (!attached.ok) throw new Error(attached.error.hint);
    rhiAttachment = attached.value;
    rhiCapture = createRhiCapture(attached.value);
    const capture = rhiCapture;
    rhiDebugGlobal = { captureFrame: (options) => capture.captureFrame(options) };
    Object.assign(rendererOpts, {
      rhi: attached.value.backend.rhi,
      rhiInstrumentation: createRhiInstrumentation(attached.value),
    });
    (globalThis as { __forgeax?: typeof rhiDebugGlobal }).__forgeax = rhiDebugGlobal;
  }

  let renderer: Renderer;
  let rendererDebugDrawHost: RendererHostAssembly['debugDrawHost'];
  let rendererFeatureHost: RenderFeatureHost;
  let assets: AssetRegistry;
  try {
    const constructed = await constructRuntimeRendererHost(canvas, rendererOpts, bundler);
    if (!constructed.ok) throw constructed.error;
    renderer = constructed.value.renderer;
    rendererDebugDrawHost = constructed.value.debugDrawHost;
    rendererFeatureHost = createRenderFeatureHost(constructed.value.featureHost);
    assets = constructed.value.assets;
  } catch (e: unknown) {
    cleanupRhiDebugHost();
    if (e instanceof EngineEnvironmentError) return err(e);
    const detail = e instanceof Error ? e : new Error(String(e));
    return err(
      new EngineEnvironmentError('renderer construction failed', {
        webgpuError: detail,
      }),
    );
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

  let debugDraw: DebugDraw | undefined;

  // Step 3: new World() -- the canvas form owns world lifetime, in
  // contrast to the assemble form where the host owns it.
  const world = new World(opts?.time !== undefined ? { time: opts.time } : {});
  // Step 3.1 (M2 plugin-system-unify / D-4): app-layer side effects that the
  // plugins consume via pre-injected world resources.
  //
  // Animation keeps durable clip GUIDs in graph payloads. The canvas default
  // plugin receives the renderer-owned GUID catalogue as a lookup bridge; it
  // still projects payloads into this World through the animation owner.
  // transform + animation system registration lives in the plugins (default set).

  // A normal canvas app owns its browser acquisition. An embedding host that
  // shares this physical canvas with another world supplies its routed view via
  // opts.input; createApp then consumes that one boundary instead of attaching a
  // second listener set. The host owns the supplied backend's lifetime.
  const inputHandle =
    opts?.input === undefined
      ? attachInputAuto(canvas, {
          ...(opts?.uiRoot ? { uiRoot: opts.uiRoot } : {}),
          ...(opts?.pointerLockAllowed ? { pointerLockAllowed: opts.pointerLockAllowed } : {}),
          ...(opts?.virtualJoysticks ? { virtualJoysticks: opts.virtualJoysticks } : {}),
          ...(opts?.lockProvider ? { lockProvider: opts.lockProvider } : {}),
        })
      : undefined;
  const inputBackend = opts?.input ?? inputHandle?.backend;
  const userPlugins =
    preparedExecutionBootstrap === undefined
      ? (opts?.plugins ?? [])
      : [
          executionBootstrapHostPlugin({
            ...(opts?.execution?.bootstrapPort === undefined
              ? {}
              : { port: opts.execution.bootstrapPort }),
            setPointerLockAllowed: (allowed) => inputBackend?.setPointerLockAllowed?.(allowed),
          }),
          ...(preparedExecutionBootstrap.plugins ?? []),
        ];
  let pluginContext: Context;
  try {
    pluginContext = await createWorldContext(
      world,
      mainEngineProfile({
        renderer,
        rendererDebugDrawHost,
        rendererFeatureHost,
        assets,
        animationPayloads: createAnimationPayloadLookup(assets),
        ...(inputBackend === undefined ? {} : { input: inputBackend }),
        ...(inputHandle === undefined ? {} : { inputDispose: inputHandle.cleanup }),
        ...(opts?.inputMap === undefined ? {} : { inputMap: opts.inputMap }),
        onDebugDrawReady: (value) => {
          debugDraw = value;
        },
        extensions: [
          rhiDebugHostPlugin(cleanupRhiDebugHost),
          ...userPlugins,
          canvasAspectPlugin(canvas),
        ],
      }),
    );
  } catch (cause) {
    cleanupRhiDebugHost();
    return err(
      makeAppError(
        'app-plugin-activation-failed',
        APP_EXPECTED['app-plugin-activation-failed'],
        APP_ERROR_HINTS['app-plugin-activation-failed'],
        { cause },
      ),
    );
  }
  const audioBackend = pluginContext.audio;

  const executionControl = createLocalExecutionControl(
    executionContext === undefined
      ? {
          ...createExecutionReport('main-serial', unavailableExecutionCapabilities('not required')),
          actualTier: 'main-serial',
          selectionReason: 'explicit-request',
          sharedEvidencePassed: true,
          engine: { realm: 'host', health: 'idle' },
          world: {
            identity: world.identity,
            health: world.execution.health,
            partialWrite: false,
            retryable: true,
          },
        }
      : {
          ...createExecutionReport(
            opts?.execution?.tier ?? 'auto',
            executionContext.capabilities,
            executionContext.selection,
          ),
          engine: { realm: 'host', health: 'idle' },
          world: {
            identity: world.identity,
            health: world.execution.health,
            partialWrite: false,
            retryable: true,
          },
        },
    {
      ...(audioBackend === undefined ? {} : { audio: () => audioBackend.getState() }),
      world: () => ({
        identity: world.identity,
        health: world.execution.health,
        partialWrite: world.execution.fault?.partialWrite ?? false,
        retryable: world.execution.fault?.retryable ?? true,
      }),
    },
  );

  // Step 3.3: Remote eval server auto-start (deferred from Step 2.4 so
  // World is available). Dynamic import keeps @forgeax/engine-app free
  // of static dep on @forgeax/engine-remote. Component reflection crosses
  // this boundary as JSON-safe host data; app does not own any component.
  const remoteHandle = shouldStartRemote
    ? await startRemoteServer(world, renderer, assets, rhiCapture, opts?.profiler, executionControl)
    : undefined;
  if (remoteHandle !== undefined) await pluginContext.plugin(remoteServerPlugin(remoteHandle));

  const buildArgs: BuildAppArgs = {
    renderer,
    assets,
    world,
    pluginContext,
    executionControl,
    onFrameSubmitted: (event) => publishBrowserFrameSubmitted(canvas, event),
    ...(inputBackend !== undefined ? { inputBackend } : {}),
    ...(inputHandle === undefined
      ? {}
      : {
          wireOnLockErrorDispatch: (dispatch: (err: AppError) => void) => {
            inputHandle.setOnErrorDispatch(dispatch);
          },
        }),
  };
  if (audioBackend !== undefined) {
    Object.assign(buildArgs, {
      audioBackend,
    });
  }
  if (opts?.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: opts.silenceUnhandledErrors });
  }
  // M2 / D-3: canvas form forwards the host-supplied draw-source pull.
  if (opts?.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: opts.drawSource });
  }
  if (opts?.profiler !== undefined) {
    Object.assign(buildArgs, { profiler: opts.profiler });
  }
  if (rhiCapture !== undefined) {
    Object.assign(buildArgs, { rhiCapture });
  }
  if (debugDraw !== undefined) {
    Object.assign(buildArgs, { debugDraw });
  }
  if (remoteHandle !== undefined) {
    Object.assign(buildArgs, { remoteHandle });
  }

  // The aspect-sync sidecar belongs to the canvas path because it owns the DOM
  // canvas. It runs as an Update system so it shares World scheduling semantics.
  resetBrowserFrameSubmitted(canvas);
  const built = await buildApp(buildArgs);
  if (!built.ok) {
    await pluginContext.fiber.dispose();
    return built;
  }
  if (built.ok) {
    // DEV-only browser remote bridge (remote-live). A browser cannot host the
    // Node WS server that @forgeax/engine-remote/server needs, so the running
    // engine would be unreachable from a CLI in a real dev browser. Instead the
    // page dials OUT to a loopback relay and runs the ws-free eval core against
    // the live world/renderer/assets/rhiCapture.
    //
    // OPT-IN via VITE_FORGEAX_ENGINE_BRIDGE=1 (set by scripts/dev-live.mjs), NOT
    // on-by-default: a page that dials a relay which is not running makes the
    // BROWSER itself log "WebSocket connection failed" to the console — noise a
    // JS catch cannot suppress — which trips every zero-console-error browser
    // smoke (collectathon / hello-*). So a plain `pnpm --filter <app> dev` (and
    // CI) stays silent; only dev-live.mjs, which also launches the relay, turns
    // it on. Production DCE's the whole block (import.meta.env.DEV === false).
    // Additive: the Node startServer path above and app.remote are untouched.
    if (
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { DEV?: boolean; VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env?.DEV ===
        true &&
      (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env
        ?.VITE_FORGEAX_ENGINE_BRIDGE === '1'
    ) {
      const bridgePort =
        (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE_PORT?: string } }).env
          ?.VITE_FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';
      await pluginContext.plugin({
        name: 'browser-remote-bridge',
        inject: ['world', 'renderer', 'assets'],
        async apply(ctx) {
          if (ctx.renderer === undefined || ctx.assets === undefined) {
            throw new Error('browser remote bridge requires renderer and assets services');
          }
          try {
            const bridge = await import('./internal/browser-remote-bridge');
            const teardown = await bridge.installBrowserRemoteBridge({
              world: ctx.world,
              renderer: ctx.renderer,
              assets: ctx.assets,
              runtimeModule: engineRuntimeModule,
              ...(rhiCapture !== undefined ? { rhiCapture } : {}),
              ...(opts?.profiler !== undefined ? { profiler: opts.profiler } : {}),
              execution: built.value.execution,
              port: bridgePort,
            });
            ctx.effect(() => teardown, 'remote/browser-bridge');
          } catch {
            // The optional live bridge does not make App creation fail.
          }
        },
      });
    }
  }
  return built;
}

/**
 * Synchronize a DOM canvas drawing buffer with its CSS size and device pixel
 * ratio. Detached or zero-sized hosts are left untouched so a hidden canvas
 * cannot be converted into a 1x1 render target accidentally.
 */
export function syncCanvasDrawingBuffer(
  canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight' | 'width' | 'height'> & {
    readonly style?: Pick<CSSStyleDeclaration, 'width' | 'height'>;
  },
): void {
  if (
    !Number.isFinite(canvas.clientWidth) ||
    !Number.isFinite(canvas.clientHeight) ||
    canvas.clientWidth <= 0 ||
    canvas.clientHeight <= 0
  )
    return;
  // An intrinsic canvas with no CSS dimensions already has an explicit
  // drawing-buffer contract. `clientWidth` mirrors `width` for this shape;
  // multiplying it by DPR would change the caller's requested pixel size and
  // can feed that new width back as the next layout measurement. CSS-sized
  // canvases take the DPR path below (including stylesheet-sized canvases
  // whose layout width differs from the initial intrinsic width).
  const hasExplicitCssSize =
    (canvas.style?.width ?? '') !== '' || (canvas.style?.height ?? '') !== '';
  if (
    !hasExplicitCssSize &&
    canvas.clientWidth === canvas.width &&
    canvas.clientHeight === canvas.height
  ) {
    return;
  }
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  const previous = syncedCanvasSizes.get(canvas);
  const drawingBufferIsTheLayoutMeasurement =
    previous !== undefined &&
    canvas.width === previous.drawingWidth &&
    canvas.height === previous.drawingHeight &&
    canvas.clientWidth === previous.drawingWidth &&
    canvas.clientHeight === previous.drawingHeight;
  const cssWidth = drawingBufferIsTheLayoutMeasurement ? previous.cssWidth : canvas.clientWidth;
  const cssHeight = drawingBufferIsTheLayoutMeasurement ? previous.cssHeight : canvas.clientHeight;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  syncedCanvasSizes.set(canvas, {
    cssWidth,
    cssHeight,
    drawingWidth: width,
    drawingHeight: height,
  });
}

/** Measure a CSS-sized canvas without mutating its drawing buffer. */
export function measureCanvasDrawingBuffer(
  canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight' | 'width' | 'height'> & {
    readonly style?: Pick<CSSStyleDeclaration, 'width' | 'height'>;
  },
  maxCanvasPixelRatio?: number,
): { readonly width: number; readonly height: number } {
  if (
    !Number.isFinite(canvas.clientWidth) ||
    !Number.isFinite(canvas.clientHeight) ||
    canvas.clientWidth <= 0 ||
    canvas.clientHeight <= 0
  ) {
    return { width: canvas.width, height: canvas.height };
  }
  const hasExplicitCssSize =
    (canvas.style?.width ?? '') !== '' || (canvas.style?.height ?? '') !== '';
  if (
    !hasExplicitCssSize &&
    canvas.clientWidth === canvas.width &&
    canvas.clientHeight === canvas.height
  ) {
    return { width: canvas.width, height: canvas.height };
  }
  const devicePixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
  const dpr =
    maxCanvasPixelRatio === undefined ||
    !Number.isFinite(maxCanvasPixelRatio) ||
    maxCanvasPixelRatio <= 0
      ? devicePixelRatio
      : Math.min(devicePixelRatio, maxCanvasPixelRatio);
  const previous = syncedCanvasSizes.get(canvas);
  const drawingBufferIsTheLayoutMeasurement =
    previous !== undefined &&
    canvas.width === previous.drawingWidth &&
    canvas.height === previous.drawingHeight &&
    canvas.clientWidth === previous.drawingWidth &&
    canvas.clientHeight === previous.drawingHeight;
  const cssWidth = drawingBufferIsTheLayoutMeasurement ? previous.cssWidth : canvas.clientWidth;
  const cssHeight = drawingBufferIsTheLayoutMeasurement ? previous.cssHeight : canvas.clientHeight;
  return {
    width: Math.max(1, Math.round(cssWidth * dpr)),
    height: Math.max(1, Math.round(cssHeight * dpr)),
  };
}

const syncedCanvasSizes = new WeakMap<
  object,
  {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly drawingWidth: number;
    readonly drawingHeight: number;
  }
>();

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

  const query = world.query({ with: [Camera] }).unwrap();
  for (const row of query) {
    const entity = row.entity;
    const r = world.get(entity, Camera);
    if (!r.ok) continue;
    // world.get narrows the bool column to a real boolean (D-5); the
    // perspective discriminator is the numeric column value.
    if (r.value.autoAspect !== true) continue;
    if (r.value.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
    world.set(entity, Camera, { aspect });
  }
}

async function startRemoteServer(
  world: World,
  renderer: Renderer,
  assets: AssetRegistry | undefined,
  rhiCapture: RhiCapture | undefined,
  profiler: import('@forgeax/engine-profiler').Profiler | undefined,
  execution: ExecutionControl,
): Promise<{ readonly port: number; close(): Promise<void> } | undefined> {
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
        rhiCapture?: unknown;
        introspection?: readonly unknown[];
        profiler?: unknown;
        execution?: unknown;
      }) => Promise<{
        ok: boolean;
        value?: { port: number; close(): Promise<void> };
      }>;
    };
    const serverResult = await remoteServerMod.startServer({
      port: 0,
      host: '127.0.0.1',
      world,
      renderer,
      assets,
      introspection: projectComponentIntrospection(world.components.entries()),
      ...(rhiCapture !== undefined ? { rhiCapture } : {}),
      ...(profiler !== undefined ? { profiler } : {}),
      execution,
    });
    if (serverResult.ok && serverResult.value !== undefined) {
      return { port: serverResult.value.port, close: serverResult.value.close };
    }
  } catch (_error) {
    // Dynamic import or server start failed; the app continues without remote.
  }
  return undefined;
}

async function createAppFromAssemble(
  args: AppAssembleArgs,
): Promise<Result<App, AssembleAppError>> {
  let pluginContext: Context;
  try {
    pluginContext = await createWorldContext(
      args.world,
      assembledEngineProfile({
        renderer: args.renderer,
        ...(args.assets === undefined ? {} : { assets: args.assets }),
        extensions: args.plugins ?? [],
      }),
    );
  } catch (cause) {
    return err(
      makeAppError(
        'app-plugin-activation-failed',
        APP_EXPECTED['app-plugin-activation-failed'],
        APP_ERROR_HINTS['app-plugin-activation-failed'],
        { cause },
      ),
    );
  }

  const shouldStartRemote = resolveRemoteServeFlag(
    undefined,
    (globalThis as { process?: { env?: { FORGEAX_ENGINE_REMOTE_SERVE?: string } } }).process?.env,
  );
  const assembledAudioBackend = pluginContext.audio;
  const executionControl = createLocalExecutionControl(
    {
      ...createExecutionReport('main-serial', unavailableExecutionCapabilities('not required')),
      actualTier: 'main-serial',
      selectionReason: 'explicit-request',
      sharedEvidencePassed: true,
      engine: { realm: 'host', health: 'idle' },
      world: {
        identity: args.world.identity,
        health: args.world.execution.health,
        partialWrite: false,
        retryable: true,
      },
    },
    {
      ...(assembledAudioBackend === undefined
        ? {}
        : { audio: () => assembledAudioBackend.getState() }),
      world: () => ({
        identity: args.world.identity,
        health: args.world.execution.health,
        partialWrite: args.world.execution.fault?.partialWrite ?? false,
        retryable: args.world.execution.fault?.retryable ?? true,
      }),
    },
  );
  const remoteHandle = shouldStartRemote
    ? await startRemoteServer(
        args.world,
        args.renderer,
        args.assets,
        undefined,
        args.profiler,
        executionControl,
      )
    : undefined;
  if (remoteHandle !== undefined) await pluginContext.plugin(remoteServerPlugin(remoteHandle));

  const buildArgs: BuildAppArgs = {
    renderer: args.renderer,
    world: args.world,
    pluginContext,
    executionControl,
    ...(remoteHandle !== undefined ? { remoteHandle } : {}),
  };

  const assembledInputBackend = pluginContext.input;
  if (assembledInputBackend !== undefined) {
    Object.assign(buildArgs, {
      inputBackend: assembledInputBackend,
    });
  }
  if (assembledAudioBackend !== undefined) {
    Object.assign(buildArgs, {
      audioBackend: assembledAudioBackend,
    });
  }
  if (args.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: args.silenceUnhandledErrors });
  }
  // M2 / D-3: assemble form forwards the host-supplied draw-source pull.
  if (args.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: args.drawSource });
  }
  if (args.profiler !== undefined) {
    Object.assign(buildArgs, { profiler: args.profiler });
  }
  const built = await buildApp(buildArgs);
  if (!built.ok) await pluginContext.fiber.dispose();
  return built;
}

interface BuildAppArgs {
  readonly renderer: Renderer;
  readonly assets?: AssetRegistry;
  readonly world: World;
  readonly pluginContext: Context;
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
  readonly silenceUnhandledErrors?: boolean;
  /** Optional App-owned RHI capture capability. */
  readonly rhiCapture?: RhiCapture;
  /** feat-20260615 debug-draw M5: DebugDraw instance created by createDebugDrawOnReady. */
  readonly debugDraw?: DebugDraw;
  /** feat-20260629 M4 / w20: remote eval server handle from createAppFromCanvas. */
  readonly remoteHandle?: { readonly port: number; close(): Promise<void> };
  /**
   * feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3:
   * per-frame draw-source pull forwarded verbatim into the frame-loop. Absent =>
   * the allocation-free primary-World path. Both createApp forms (canvas + assemble) forward
   * it from their respective options object.
   */
  readonly drawSource?: () =>
    | {
        worlds: readonly import('@forgeax/engine-ecs').World[];
        cameraOwner: number;
        resourceOwner: number;
      }
    | undefined;
  readonly profiler?: import('@forgeax/engine-profiler').Profiler;
  readonly executionControl?: import('./execution/control').LocalExecutionControl;
  /** Canvas-form projection of the Renderer frame-submitted event. */
  readonly onFrameSubmitted?: (event: {
    readonly frameId: number;
    readonly deviceGeneration: number;
  }) => void;
}

/**
 * Internal builder shared by both overloads. Wires the frame-loop +
 * listener-registry onError and returns the App handle. Effectful ownership
 * has already moved into pluginContext before this boundary runs.
 */
async function buildApp(args: BuildAppArgs): Promise<Result<App, AppError | RhiError>> {
  const {
    renderer,
    world,
    pluginContext,
    inputBackend,
    audioBackend,
    silenceUnhandledErrors,
    rhiCapture,
    debugDraw,
    remoteHandle,
    profiler,
  } = args;

  // Physics is a Context service; the App exposes the active provider without
  // storing a second mutable slot.
  function readPhysicsWorld():
    | import('@forgeax/engine-physics').PhysicsWorld
    | import('@forgeax/engine-physics').PhysicsWorld2D
    | undefined {
    return pluginContext.physics;
  }
  // M4 (w11): listener registry replaces the M3 inline Set so console.error
  // fallback + duplicate-add no-op + unsubscribe handle behaviour matches
  // packages/runtime/src/createRenderer.ts:532-566 LostListenerRegistry
  // (plan-strategy D-9). silenceUnhandledErrors threads through verbatim.
  const fanout = new ErrorFanoutRegistry(
    silenceUnhandledErrors !== undefined ? { silenceUnhandledErrors } : {},
  );
  let lastError: AppDispatchError | undefined;
  const execution =
    args.executionControl ??
    createLocalExecutionControl(
      {
        ...createExecutionReport('main-serial', unavailableExecutionCapabilities('not required')),
        actualTier: 'main-serial',
        selectionReason: 'explicit-request',
        sharedEvidencePassed: true,
        engine: { realm: 'host', health: 'idle' },
        world: {
          identity: world.identity,
          health: world.execution.health,
          partialWrite: world.execution.fault?.partialWrite ?? false,
          retryable: world.execution.fault?.retryable ?? true,
        },
      },
      {
        ...(audioBackend === undefined ? {} : { audio: () => audioBackend.getState() }),
        world: () => ({
          identity: world.identity,
          health: world.execution.health,
          partialWrite: world.execution.fault?.partialWrite ?? false,
          retryable: world.execution.fault?.retryable ?? true,
        }),
      },
    );

  function dispatch(e: AppDispatchError): void {
    lastError = e;
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
  // M2 / D-3: forward the optional draw-source pull into the frame-loop. Absent
  // => the loop keeps the allocation-free primary-World draw path.
  if (args.drawSource !== undefined) {
    Object.assign(loopOpts, { drawSource: args.drawSource });
  }
  if (profiler !== undefined) {
    Object.assign(loopOpts, { profiler });
  }
  const loop = createFrameLoop(loopOpts);
  if (rhiCapture !== undefined) {
    bindRhiCaptureFrameDriver(rhiCapture, {
      getState: () => loop.getState(),
      pause: () => {
        const result = loop.pause();
        if (result.ok) execution.setEngineHealth('idle');
        return result;
      },
      resume: () => {
        const result = loop.resume();
        if (result.ok) execution.setEngineHealth('running');
        return result;
      },
      stepFrame: (deltaSeconds) => loop.stepFrame(deltaSeconds),
    });
  }
  // M4 (w13) device-lost internal subscription. R-1 timing contract:
  // app.start() arms the rAF handle BEFORE this listener subscribes, so
  // a synchronous late-attach replay of a persisted device-lost event
  // (LostListenerRegistry replay -- runtime/src/renderer.ts:337-345)
  // hits a frame-loop with a real rAF handle to cancel (M2 setStopped
  // tolerates pendingFrameId === 0 as a no-op so even pre-rAF replays
  // do not NPE). The subscription remains active across pause / resume;
  // unsubscribe runs only on stop / disposal (charter P3:
  // device-lost is a terminal lifecycle signal, not a transient blip).
  let rendererUnsubscribe: (() => void) | undefined;
  let resumeAfterSurfaceRestore = false;

  function subscribeRendererErrors(): void {
    if (rendererUnsubscribe !== undefined) {
      return;
    }
    rendererUnsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') {
        args.onFrameSubmitted?.(event);
        return;
      }
      if (event.kind !== 'error') return;
      const e: RenderError = event.error;
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
    ...(args.assets === undefined ? {} : { assets: args.assets }),
    world,
    execution,
    async releaseSurfacePreserveWorld(): Promise<Result<void, RhiError | RenderError>> {
      if (loop.getState() === 'running') {
        const paused = loop.pause();
        if (!paused.ok) {
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'running App pauses before releasing its presentation surface',
              hint: paused.error.hint,
            }),
          );
        }
        resumeAfterSurfaceRestore = true;
        execution.setEngineHealth('idle');
      }
      // A surface handoff can be requested by an Update system while the
      // current frame is still in progress. Let that frame reach renderer.draw
      // before unconfiguring the surface; pause() only cancels the next rAF.
      await Promise.resolve();
      const released = renderer.releaseSurface();
      if (!released.ok && resumeAfterSurfaceRestore) {
        loop.resume();
        resumeAfterSurfaceRestore = false;
        execution.setEngineHealth('running');
      }
      return released.ok ? ok(undefined) : err(released.error);
    },
    async restoreSurface(): Promise<Result<void, RhiError | RenderError>> {
      const restored = renderer.restoreSurface();
      if (!restored.ok) return err(restored.error);
      if (resumeAfterSurfaceRestore) {
        const resumed = loop.resume();
        if (!resumed.ok) {
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'paused App resumes after restoring its presentation surface',
              hint: resumed.error.hint,
            }),
          );
        }
        resumeAfterSurfaceRestore = false;
        execution.setEngineHealth('running');
      }
      return ok(undefined);
    },
    pluginContext,
    ...(inputBackend !== undefined ? { input: inputBackend } : {}),
    ...(audioBackend !== undefined ? { audio: audioBackend } : {}),
    get physics():
      | import('@forgeax/engine-physics').PhysicsWorld
      | import('@forgeax/engine-physics').PhysicsWorld2D
      | undefined {
      return readPhysicsWorld();
    },
    start(): Result<void, AppError> {
      // R-1: arm the rAF handle FIRST (loop.start schedules raf(tick))
      // and only THEN subscribe to renderer events. If the renderer
      // late-attach replays a persisted device-lost event during the
      // subscribe call, the loop is already armed and can retain the error.
      const r = loop.start();
      if (r.ok) {
        execution.setEngineHealth('running');
        subscribeRendererErrors();
      }
      return r;
    },
    stop(): Result<void, AppError> {
      const r = loop.stop();
      if (r.ok) execution.setEngineHealth('stopped');
      unsubscribeRendererErrors();
      return r;
    },
    async dispose(): Promise<Result<void, AppError>> {
      const state = loop.getState();
      if (state === 'running' || state === 'paused') loop.stop();
      else if (state !== 'stopped') loop.setStopped();
      await pluginContext.fiber.dispose();
      unsubscribeRendererErrors();
      execution.setEngineHealth('stopped');
      return ok(undefined);
    },
    pause(): Result<void, AppError> {
      const r = loop.pause();
      if (r.ok) execution.setEngineHealth('idle');
      return r;
    },
    resume(): Result<void, AppError> {
      const r = loop.resume();
      if (r.ok) execution.setEngineHealth('running');
      return r;
    },
    stepFrame(deltaSeconds): Result<void, AppDispatchError> {
      return loop.stepFrame(deltaSeconds);
    },
    onError(cb: (e: AppDispatchError) => void): () => void {
      return fanout.add(cb);
    },
    setDrawSource(drawSource): void {
      loop.setDrawSource(drawSource);
    },
    /**
     * Most recent dispatched error retained for host self-inspection.
     */
    get lastError(): AppDispatchError | undefined {
      return lastError;
    },
    ...(rhiCapture !== undefined ? { rhiCapture } : {}),
    ...(debugDraw !== undefined ? { debugDraw } : {}),
    ...(remoteHandle !== undefined ? { remote: remoteHandle } : {}),
  };

  return ok(stub);
}
