import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { attachBrowserInputBackend, type InputBackend } from '@forgeax/engine-input';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameSubmitted,
} from '../browser-frame-signal';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { ErrorFanoutRegistry } from '../internal/error-fanout';
import type { BundlerOptions, CanvasDrawingBufferSize } from '../types';
import {
  APP_PHASE_CATALOG,
  type AppDispatchError,
  type CreateAppOptions,
  type ExecutionApp,
} from '../types';
import { normalizeExecutionBootstrapUrl } from './bootstrap-url';
import { cloneExecutionReport } from './control';
import { type EngineWorkerSession, startEngineWorker } from './engine-worker';
import { createMeasurementSeries } from './measurement';
import {
  type EngineToHostMessage,
  type ExecutionFaultMessage,
  FrameCreditLedger,
} from './protocol';
import { createExecutionReport, executionAudioReport } from './report';
import type {
  ExecutionCapabilities,
  ExecutionControl,
  ExecutionReport,
  ExecutionSelection,
} from './types';

export interface CreateWorkerExecutionAppOptions {
  readonly canvas: HTMLCanvasElement;
  readonly appOptions: CreateAppOptions;
  /** Host-owned resize policy applied before each frame sent to the worker. */
  readonly syncCanvas?: (canvas: HTMLCanvasElement) => CanvasDrawingBufferSize;
  readonly bundler?: BundlerOptions;
  readonly capabilities: ExecutionCapabilities;
  readonly selection: ExecutionSelection;
}

function lifecycleError(code: 'app-not-started' | 'app-already-running'): AppErrorType {
  return new AppError({
    code,
    expected: APP_EXPECTED[code],
    hint: APP_ERROR_HINTS[code],
    detail: {},
  });
}

function runtimeError(message: ExecutionFaultMessage): AppErrorType {
  if (message.code === 'shared-kernel-failed' && message.worldIdentity !== null) {
    return new AppError({
      code: 'app-execution-kernel-failed',
      expected: APP_EXPECTED['app-execution-kernel-failed'],
      hint: APP_ERROR_HINTS['app-execution-kernel-failed'],
      detail: {
        kernelName: (message.detail as { kernelName?: string })?.kernelName ?? 'unknown',
        worldIdentity: message.worldIdentity,
        cause: message.detail,
        partialWrite: true,
        retryable: false,
      },
    });
  }
  return new AppError({
    code: 'app-system-update-failed',
    expected: APP_EXPECTED['app-system-update-failed'],
    hint: APP_ERROR_HINTS['app-system-update-failed'],
    detail: { cause: message.detail },
  });
}

export async function createWorkerExecutionApp(
  options: CreateWorkerExecutionAppOptions,
): Promise<Result<ExecutionApp, AppErrorType>> {
  const executionOptions = options.appOptions.execution;
  if (executionOptions === undefined) throw new Error('execution options are required');
  const normalizedBootstrap = normalizeExecutionBootstrapUrl(executionOptions.bootstrap);
  if (!normalizedBootstrap.ok) return normalizedBootstrap;
  const bootstrapUrl = normalizedBootstrap.value;
  const startupTimeoutMs = executionOptions.startupTimeoutMs ?? 10_000;
  const frameTimeoutMs = executionOptions.frameTimeoutMs ?? 2_000;
  const syncCanvas = options.syncCanvas;
  let canvas = options.canvas;
  let renderEpoch = 1;
  resetBrowserFrameSubmitted(canvas);
  const started = await startEngineWorker({
    canvas: canvas,
    bootstrapUrl,
    ...(executionOptions.bootstrapData === undefined
      ? {}
      : { bootstrapData: executionOptions.bootstrapData }),
    ...(executionOptions.bootstrapPort === undefined
      ? {}
      : { bootstrapPort: executionOptions.bootstrapPort }),
    ...(executionOptions.assetCatalog === undefined
      ? {}
      : { assetCatalog: executionOptions.assetCatalog }),
    ...(options.bundler?.shaderManifestUrl !== undefined
      ? { shaderManifestUrl: options.bundler.shaderManifestUrl }
      : {}),
    ...(options.bundler?.build !== undefined ? { build: options.bundler.build } : {}),
    ...(options.appOptions.time !== undefined ? { time: options.appOptions.time } : {}),
    ...(executionOptions.diagnostics === undefined
      ? {}
      : { diagnostics: executionOptions.diagnostics }),
    timeoutMs: startupTimeoutMs,
    workers: options.selection,
  });
  if (!started.ok) return started;

  const session: EngineWorkerSession = started.value;
  const profiler = options.appOptions.profiler;
  const phaseCatalogRegistration = profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  let releasePhaseCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  const fanout = new ErrorFanoutRegistry(
    options.appOptions.silenceUnhandledErrors === undefined
      ? {}
      : { silenceUnhandledErrors: options.appOptions.silenceUnhandledErrors },
  );
  const attachInput = () =>
    options.appOptions.input === undefined
      ? attachBrowserInputBackend(canvas, {
          ...(options.appOptions.uiRoot !== undefined ? { uiRoot: options.appOptions.uiRoot } : {}),
          ...(options.appOptions.pointerLockAllowed !== undefined
            ? { pointerLockAllowed: options.appOptions.pointerLockAllowed }
            : {}),
          ...(options.appOptions.virtualJoysticks !== undefined
            ? { virtualJoysticks: options.appOptions.virtualJoysticks }
            : {}),
          ...(options.appOptions.lockProvider !== undefined
            ? { lockProvider: options.appOptions.lockProvider }
            : {}),
          onLockError: (detail) =>
            fanout.fire(
              new AppError({
                code: 'app-pointer-lock-failed',
                expected: APP_EXPECTED['app-pointer-lock-failed'],
                hint: APP_ERROR_HINTS['app-pointer-lock-failed'],
                detail,
              }),
            ),
        })
      : undefined;
  let inputHandle = attachInput();
  const physicalInput: InputBackend = {
    sample: () => {
      if (inputHandle === undefined) throw new Error('Host input was detached');
      return inputHandle.backend.sample();
    },
    detach: () => inputHandle?.backend.detach(),
  };
  // Resolve the decorator lazily so lightweight test hosts that provide only
  // the physical browser backend remain valid; production input exports it.
  let compositeFactory: typeof import('@forgeax/engine-input').makeCompositeBackend | undefined;
  try {
    const inputModule = (await import(
      '@forgeax/engine-input'
    )) as typeof import('@forgeax/engine-input');
    compositeFactory = inputModule.makeCompositeBackend;
  } catch {
    // Minimal test hosts may intentionally expose only the physical backend.
  }
  const input: InputBackend = options.appOptions.input ??
    (inputHandle === undefined
      ? undefined
      : typeof compositeFactory === 'function'
        ? compositeFactory(physicalInput)
        : physicalInput) ?? {
      sample: () => ({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      detach: () => {},
    };

  // The Worker owns its own synthetic-input state.  A bridge disconnect can
  // therefore revoke that state without closing the browser or terminating
  // the Worker; the next admitted frame observes the release edges.
  const clearWorkerInput = (): void => {
    try {
      session.post({ kind: 'input-clear' });
    } catch {
      // The session is already terminal; there is no live Worker state left.
    }
  };
  const beginWorkerInputLease = (): void => {
    try {
      session.post({ kind: 'input-lease-open' });
    } catch {
      // The session is already terminal; no future lease can be admitted.
    }
  };
  const finishWorkerProfiler = (expected?: {
    readonly worldIdentity?: string;
    readonly captureId?: string;
  }): void => {
    try {
      session.post({ kind: 'profile-finish', ...(expected ?? {}) });
    } catch {
      // Diagnostic cleanup is best effort and never changes App lifecycle.
    }
  };
  const clearHostInjectedInput = (): void => {
    if (inputHandle === undefined) return;
    const value = input as {
      revokeInjectedLease?: () => void;
      clearInjected?: () => void;
    };
    value.revokeInjectedLease?.();
    if (value.revokeInjectedLease === undefined) value.clearInjected?.();
  };

  let report: ExecutionReport = {
    ...createExecutionReport(options.capabilities, options.selection),
    engine: { realm: 'worker', health: 'idle' },
    ...(options.selection.render.enabled
      ? { render: { epoch: 1, state: 'alive' as const, submittedFrame: 0, completedFrame: 0 } }
      : {}),
    world: {
      identity: session.ready.worldIdentity,
      health: 'healthy',
      partialWrite: false,
      retryable: true,
    },
  };
  let state: 'idle' | 'running' | 'paused' | 'stopped' | 'faulted' = 'idle';
  let ledger = new FrameCreditLedger(session.ready.worldIdentity);
  let rafId = 0;
  let lastTimestamp = 0;
  let temporalResetPending = false;
  let frameDeadline: ReturnType<typeof setTimeout> | undefined;
  type FrameAdmission = {
    readonly session: EngineWorkerSession;
    readonly worldIdentity: string;
    readonly frameId: number;
  };
  let frameAdmission: FrameAdmission | undefined;
  let lastError: AppDispatchError | undefined;
  let rebuildResolve: ((result: Result<ExecutionReport, AppErrorType>) => void) | undefined;
  let rebuildInFlight: Promise<Result<ExecutionReport, AppErrorType>> | undefined;
  const hostFrameMeasurements = createMeasurementSeries();
  const engineMeasurements = createMeasurementSeries();
  const kernelMeasurements = createMeasurementSeries();
  const audioMeasurements = createMeasurementSeries();
  let audio = createHostAudioConsumer();
  let frameSentAt = 0;
  let profilerCaptureId: string | undefined;
  let profilerFrameId = 0;
  let frameProfile = profiler?.activeSession();
  let profileFrameOpen = false;
  let hostFrameOpen = false;
  let nextInspectionId = 1;
  const pendingInspections = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly startedResolve: () => void;
      readonly startedReject: (error: unknown) => void;
      readonly worldIdentity: string;
      settled: boolean;
      cancelRequested: boolean;
      cancelResolve: ((admitted: boolean) => void) | undefined;
    }
  >();

  const rejectPendingInspections = (error: unknown): void => {
    for (const pending of pendingInspections.values()) {
      pending.reject(error);
      pending.startedReject(error);
      pending.cancelResolve?.(false);
    }
    pendingInspections.clear();
  };

  const setEngineHealth = (health: ExecutionReport['engine']['health']): void => {
    report = {
      ...report,
      engine: { ...report.engine, health },
      ...(health === 'stopped' && report.render !== undefined
        ? { render: { ...report.render, state: 'stopped' as const } }
        : {}),
    };
  };

  const finishProfile = (): void => {
    if (hostFrameOpen) frameProfile?.endPhase();
    if (profileFrameOpen) frameProfile?.endFrame();
    frameProfile = undefined;
    profileFrameOpen = false;
    hostFrameOpen = false;
    try {
      profiler?.activeSession()?.finish();
    } catch {}
    releasePhaseCatalog?.();
    releasePhaseCatalog = undefined;
  };

  const clearFrameAdmissionWatchdog = (expected?: FrameAdmission): void => {
    if (
      expected !== undefined &&
      (frameAdmission === undefined ||
        frameAdmission.session !== expected.session ||
        frameAdmission.worldIdentity !== expected.worldIdentity ||
        frameAdmission.frameId !== expected.frameId)
    ) {
      return;
    }
    if (frameDeadline !== undefined) clearTimeout(frameDeadline);
    frameDeadline = undefined;
    frameAdmission = undefined;
  };

  let disposal: ReturnType<EngineWorkerSession['dispose']> | undefined;
  const disposeSession = () => {
    rebuildResolve?.(err(lifecycleError('app-not-started')));
    rebuildResolve = undefined;
    rebuildInFlight = undefined;
    disposal ??= session.dispose();
    return disposal;
  };

  const terminalFault = (message: ExecutionFaultMessage): void => {
    clearFrameAdmissionWatchdog();
    const error = runtimeError(message);
    lastError = error;
    rejectPendingInspections(error);
    state = message.partialWrite ? 'faulted' : 'stopped';
    report = {
      ...report,
      engine: { ...report.engine, health: 'faulted' },
      ...(report.render === undefined
        ? {}
        : { render: { ...report.render, state: 'failed' as const } }),
      world: {
        identity: message.worldIdentity,
        health: message.partialWrite ? 'poisoned' : report.world.health,
        partialWrite: message.partialWrite,
        retryable: message.retryable,
      },
      kernelDispatch: {
        ...report.kernelDispatch,
        reason: message.partialWrite ? 'poisoned' : report.kernelDispatch.reason,
      },
      fault: {
        source: message.source,
        code: message.code,
        expected: message.expected,
        hint: message.hint,
        detail: message.detail,
        partialWrite: message.partialWrite,
        retryable: message.retryable,
      },
    };
    fanout.fire(error);
    if (!message.partialWrite) {
      audio.dispose();
      disposeSession();
    }
    finishProfile();
  };

  const armFrameAdmission = (worldIdentity: string, frameId: number): void => {
    const admission = {
      session,
      worldIdentity,
      frameId,
    } as const;
    frameAdmission = admission;
    frameDeadline = setTimeout(() => {
      // The callback can remain queued after a matching submitted message
      // clears the timer. Keep the identity fence so it cannot fault a
      // later frame if the runtime delivers that stale callback.
      if (state !== 'running' || frameAdmission !== admission) return;
      terminalFault({
        kind: 'fault',
        worldIdentity: admission.worldIdentity,
        source: 'runtime',
        code: 'app-execution-deadline-exceeded',
        expected: APP_EXPECTED['app-execution-deadline-exceeded'],
        hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
        detail: { phase: 'frame', timeoutMs: frameTimeoutMs },
        partialWrite: false,
        retryable: false,
      });
    }, frameTimeoutMs);
  };

  let rafPending = false;
  // Source frame IDs are monotonic across renderer replacement. A lost epoch
  // retires its outstanding frames; a new baseline starts at this floor.
  let renderRecoveryFloor = 0;
  const scheduleFrame = (): void => {
    if (rafPending) return;
    rafPending = true;
    rafId = requestAnimationFrame((timestamp) => {
      rafPending = false;
      if (state !== 'running' || ledger.hasCreditInFlight) return;
      if (
        report.render !== undefined &&
        (report.render.state === 'rebuilding' ||
          ledger.inspect().submitted -
            Math.max(renderRecoveryFloor, report.render.completedFrame) >=
            2)
      )
        return;
      const deltaSeconds =
        lastTimestamp === 0 ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1_000);
      lastTimestamp = timestamp;
      const canvasSize =
        syncCanvas?.(canvas) ??
        ({
          width: canvas.width,
          height: canvas.height,
        } satisfies CanvasDrawingBufferSize);
      const frame = ledger.issue(
        deltaSeconds,
        () => input.sample(),
        canvasSize,
        timestamp / 1_000,
        temporalResetPending,
      );
      report = { ...report, frame: ledger.inspect() };
      if (frame === undefined) return;
      frameProfile = profiler?.activeSession();
      if (frameProfile !== undefined && profilerCaptureId !== frameProfile.captureId) {
        profilerCaptureId = frameProfile.captureId;
        profilerFrameId = 0;
      }
      profileFrameOpen = frameProfile?.beginFrame(++profilerFrameId).ok ?? false;
      hostFrameOpen = profileFrameOpen
        ? (frameProfile?.beginPhase('app', 'host-frame').ok ?? false)
        : false;
      frameSentAt = performance.now();
      armFrameAdmission(frame.worldIdentity, frame.frameId);
      session.post(frame);
    });
  };

  const replaceCanvas = (): OffscreenCanvas => {
    const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
    clearHostInjectedInput();
    inputHandle?.();
    canvas.replaceWith(replacement);
    canvas = replacement;
    inputHandle = attachInput();
    resetBrowserFrameSubmitted(canvas);
    return canvas.transferControlToOffscreen();
  };
  session.listen((message: EngineToHostMessage) => {
    if (disposal !== undefined) return;
    if (message.kind === 'render-ready') {
      if (message.epoch !== renderEpoch || state === 'stopped' || state === 'faulted') return;
      if (report.render !== undefined)
        report = { ...report, render: { ...report.render, state: 'alive' } };
      if (ledger.hasCreditInFlight && report.world.identity !== null)
        armFrameAdmission(report.world.identity, ledger.inspect().submitted);
      if (state === 'running') scheduleFrame();
      return;
    }
    if (message.kind === 'render-lost') {
      if (message.epoch <= renderEpoch || state === 'stopped' || state === 'faulted') return;
      renderEpoch = message.epoch;
      renderRecoveryFloor = ledger.inspect().completed;
      clearFrameAdmissionWatchdog();
      report = {
        ...report,
        render: { epoch: renderEpoch, state: 'rebuilding', submittedFrame: 0, completedFrame: 0 },
      };
      const offscreen = replaceCanvas();
      session.post({ kind: 'render-replace', epoch: renderEpoch, canvas: offscreen }, [offscreen]);
      return;
    }
    if (message.kind === 'render-submitted' || message.kind === 'render-complete') {
      if (
        message.epoch !== renderEpoch ||
        message.frame.worldIdentity !== report.world.identity ||
        state === 'stopped' ||
        state === 'faulted'
      )
        return;
      if (message.kind === 'render-submitted') {
        report = {
          ...report,
          render: {
            epoch: renderEpoch,
            state: 'alive',
            submittedFrame: message.frame.frameId,
            completedFrame: report.render?.completedFrame ?? 0,
          },
        };
        publishBrowserFrameSubmitted(canvas, message.frame);
      } else {
        report = {
          ...report,
          render: {
            epoch: renderEpoch,
            state: 'alive',
            submittedFrame: report.render?.submittedFrame ?? message.frame.frameId,
            completedFrame: message.frame.frameId,
          },
        };
        publishBrowserFrameCompleted(canvas, {
          ...message.frame,
          deviceGeneration: message.frame.deviceGeneration ?? 0,
          presentation: message.frame.presentation ?? 'pending',
        });
        if (state === 'running') scheduleFrame();
      }
      return;
    }
    if (message.kind === 'frame-submitted') {
      const admission = frameAdmission;
      if (
        admission === undefined ||
        admission.session !== session ||
        admission.worldIdentity !== report.world.identity ||
        admission.worldIdentity !== message.worldIdentity ||
        admission.frameId !== message.frameId
      ) {
        return;
      }
      clearFrameAdmissionWatchdog(admission);
      publishBrowserFrameSubmitted(canvas, message);
      return;
    }
    if (message.kind === 'frame-complete' || message.kind === 'simulation-complete') {
      if (ledger.complete(message) !== 'accepted') return;
      temporalResetPending = false;
      if (message.kind === 'frame-complete')
        publishBrowserFrameCompleted(canvas, {
          frameId: message.frameId,
          deviceGeneration: message.deviceGeneration ?? 0,
          ...(message.graphGeneration === undefined
            ? {}
            : { graphGeneration: message.graphGeneration }),
          ...(message.barrelDistortion === undefined
            ? {}
            : { barrelDistortion: message.barrelDistortion }),
          worldIdentity: message.worldIdentity,
          // Completion without the Render receipt's explicit presentation fact
          // is not evidence that the active scene is visible. Fail closed so a
          // protocol omission cannot dismiss the startup screen.
          presentation: message.presentation ?? 'pending',
        });
      report = { ...report, frame: ledger.inspect() };
      clearFrameAdmissionWatchdog({
        session,
        worldIdentity: message.worldIdentity,
        frameId: message.frameId,
      });
      if (hostFrameOpen) frameProfile?.endPhase();
      if (profileFrameOpen) {
        frameProfile?.recordSkip({
          source: 'app',
          phase: 'engine-update',
          reason: `worker-report:${message.engineUpdateMs.toFixed(3)}ms`,
        });
        frameProfile?.recordSkip({
          source: 'app',
          phase: 'kernel-wait',
          reason: `worker-report:${message.kernelWaitMs.toFixed(3)}ms`,
        });
      }
      const audioStarted = performance.now();
      const audioProfileOpen = profileFrameOpen
        ? (frameProfile?.beginPhase('app', 'host-audio').ok ?? false)
        : false;
      for (const intent of message.audioIntents ?? []) audio.consume(intent);
      if (audioProfileOpen) frameProfile?.endPhase();
      const audioMs = performance.now() - audioStarted;
      report = {
        ...report,
        performance: {
          ...report.performance,
          hostFrameMs: hostFrameMeasurements.add(performance.now() - frameSentAt),
          engineUpdateMs: engineMeasurements.add(message.engineUpdateMs),
          kernelWaitMs: kernelMeasurements.add(message.kernelWaitMs),
          hostAudioMs: audioMeasurements.add(audioMs),
        },
      };
      if (message.kernelDispatch !== undefined) {
        report = { ...report, kernelDispatch: message.kernelDispatch };
      }
      if (profileFrameOpen) frameProfile?.endFrame();
      frameProfile = undefined;
      profileFrameOpen = false;
      hostFrameOpen = false;
      if (state === 'running') scheduleFrame();
    } else if (message.kind === 'fault') {
      terminalFault(message);
    } else if (message.kind === 'rebuilt') {
      clearFrameAdmissionWatchdog();
      rejectPendingInspections(
        new Error('The previous World was replaced before inspection execution.'),
      );
      audio.dispose();
      audio = createHostAudioConsumer();
      ledger = new FrameCreditLedger(message.worldIdentity);
      renderRecoveryFloor = 0;
      hostFrameMeasurements.clear();
      engineMeasurements.clear();
      kernelMeasurements.clear();
      audioMeasurements.clear();
      state = 'idle';
      report = {
        ...report,
        engine: { ...report.engine, health: 'idle' },
        // The rebuilt ACK follows complete source, kernel and renderer startup.
        // Its earlier render-ready event was ignored while the old World was faulted.
        ...(report.render === undefined
          ? {}
          : {
              render: {
                epoch: renderEpoch,
                state: 'alive' as const,
                submittedFrame: 0,
                completedFrame: 0,
              },
            }),
        world: {
          identity: message.worldIdentity,
          health: 'healthy',
          partialWrite: false,
          retryable: true,
        },
        kernelDispatch: {
          eligible: false,
          usedShared: false,
          reason: 'no-eligible-kernel',
          dispatched: 0,
          completed: 0,
        },
        fault: null,
        performance: {
          hostFrameMs: null,
          engineUpdateMs: null,
          kernelWaitMs: null,
          hostAudioMs: null,
        },
        frame: ledger.inspect(),
      };
      rebuildResolve?.(ok(cloneExecutionReport(report)));
      rebuildResolve = undefined;
      rebuildInFlight = undefined;
    } else if (message.kind === 'host-control') {
      if (message.command === 'set-pointer-lock-allowed') {
        input.setPointerLockAllowed?.(message.allowed);
      }
    } else if (message.kind === 'inspect-result') {
      const pending = pendingInspections.get(message.requestId);
      if (pending === undefined) return;
      pendingInspections.delete(message.requestId);
      if (message.worldIdentity !== pending.worldIdentity) {
        const stale = Object.assign(new Error('The inspection crossed a World rebuild'), {
          code: 'live-world-stale',
        });
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(stale);
        }
        pending.startedReject(stale);
        pending.cancelResolve?.(true);
        return;
      }
      pending.startedResolve();
      pending.cancelResolve?.(true);
      if (!pending.settled) {
        pending.settled = true;
        if (message.result.ok) pending.resolve(message.result.value);
        else pending.reject(message.result.error);
      }
    } else if (message.kind === 'inspect-started') {
      const pending = pendingInspections.get(message.requestId);
      if (pending === undefined) return;
      if (message.worldIdentity !== pending.worldIdentity) {
        const stale = Object.assign(new Error('The inspection crossed a World rebuild'), {
          code: 'live-world-stale',
        });
        pending.startedReject(stale);
        return;
      }
      pending.startedResolve();
    } else if (message.kind === 'inspect-canceled') {
      const pending = pendingInspections.get(message.requestId);
      if (pending === undefined) return;
      if (message.worldIdentity !== pending.worldIdentity) {
        const stale = Object.assign(new Error('The inspection crossed a World rebuild'), {
          code: 'live-world-stale',
        });
        pending.cancelResolve?.(true);
        pending.startedReject(stale);
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(stale);
        }
        pendingInspections.delete(message.requestId);
        return;
      }
      pending.cancelResolve?.(message.admitted);
      pending.cancelResolve = undefined;
      if (message.admitted) {
        // Admission is authoritative. The cancel() witness lets the caller
        // stop waiting, while the result Promise remains pending until the
        // Worker posts inspect-result and closes the execution.
        pending.startedResolve();
      } else {
        pendingInspections.delete(message.requestId);
        const cancelled = Object.assign(
          new Error('The inspection was cancelled before Worker admission'),
          { code: 'live-eval-cancelled-before-execution' },
        );
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(cancelled);
        }
        pending.startedReject(cancelled);
      }
    }
  });

  const remoteEval = (
    code: string,
    expectedWorldIdentity = report.world.identity ?? session.ready.worldIdentity,
  ): Promise<unknown> & {
    readonly started: Promise<void>;
    readonly cancel: () => Promise<boolean>;
  } => {
    const requestId = nextInspectionId++;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // `started` is optional metadata. The main result remains the failure owner
    // when a caller does not subscribe to admission separately.
    void started.catch(() => undefined);
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    pendingInspections.set(requestId, {
      resolve: resolveResult,
      reject: rejectResult,
      startedResolve: resolveStarted,
      startedReject: rejectStarted,
      worldIdentity: expectedWorldIdentity,
      settled: false,
      cancelRequested: false,
      cancelResolve: undefined,
    });
    session.post({ kind: 'inspect', requestId, code, worldIdentity: expectedWorldIdentity });
    let cancelPromise: Promise<boolean> | undefined;
    const cancel = (): Promise<boolean> => {
      const pending = pendingInspections.get(requestId);
      if (pending === undefined) return Promise.resolve(true);
      if (cancelPromise !== undefined) return cancelPromise;
      pending.cancelRequested = true;
      cancelPromise = new Promise<boolean>((resolve) => {
        pending.cancelResolve = resolve;
      });
      try {
        session.post({ kind: 'inspect-cancel', requestId, worldIdentity: expectedWorldIdentity });
      } catch {
        pending.cancelResolve?.(true);
        pending.cancelResolve = undefined;
      }
      return cancelPromise;
    };
    return Object.assign(result, { started, cancel });
  };

  const execution: ExecutionControl = {
    report: () =>
      cloneExecutionReport({
        ...report,
        audio: executionAudioReport(audio.state()),
      }),
    rebuild: () => {
      if (rebuildInFlight !== undefined) return rebuildInFlight;
      if (state !== 'faulted' || report.world.identity === null) {
        return Promise.resolve(
          err(
            new AppError({
              code: 'app-execution-rebuild-failed',
              expected: APP_EXPECTED['app-execution-rebuild-failed'],
              hint: APP_ERROR_HINTS['app-execution-rebuild-failed'],
              detail: {
                worldIdentity: report.world.identity,
                cause: new Error('World is not in a rebuildable poisoned state.'),
              },
            }),
          ),
        );
      }
      rebuildInFlight = new Promise((resolve) => {
        rebuildResolve = resolve;
        if (options.selection.render.enabled) {
          const offscreen = replaceCanvas();
          renderEpoch = 1;
          report = {
            ...report,
            render: { epoch: 1, state: 'rebuilding', submittedFrame: 0, completedFrame: 0 },
          };
          session.post(
            { kind: 'rebuild', worldIdentity: report.world.identity as string, canvas: offscreen },
            [offscreen],
          );
        } else session.post({ kind: 'rebuild', worldIdentity: report.world.identity as string });
        setTimeout(() => {
          if (rebuildResolve !== resolve) return;
          rebuildResolve = undefined;
          rebuildInFlight = undefined;
          resolve(
            err(
              new AppError({
                code: 'app-execution-deadline-exceeded',
                expected: APP_EXPECTED['app-execution-deadline-exceeded'],
                hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
                detail: { phase: 'handshake', timeoutMs: startupTimeoutMs },
              }),
            ),
          );
        }, startupTimeoutMs);
      });
      return rebuildInFlight;
    },
  };

  const app: ExecutionApp = {
    get canvas() {
      return canvas;
    },
    execution,
    remoteEval,
    input,
    start: () => {
      if (state === 'running') return err(lifecycleError('app-already-running'));
      if (state === 'stopped' || state === 'faulted') return err(lifecycleError('app-not-started'));
      const wasPaused = state === 'paused';
      state = 'running';
      setEngineHealth('running');
      lastTimestamp = 0;
      temporalResetPending = wasPaused;
      scheduleFrame();
      return ok(undefined);
    },
    stop: () => {
      if (state !== 'running' && state !== 'paused') return err(lifecycleError('app-not-started'));
      if (state === 'running') cancelAnimationFrame(rafId);
      rafPending = false;
      state = 'stopped';
      clearFrameAdmissionWatchdog();
      clearHostInjectedInput();
      inputHandle?.();
      clearWorkerInput();
      audio.dispose();
      rejectPendingInspections(new Error('App stopped before inspection completed.'));
      void disposeSession();
      setEngineHealth('stopped');
      finishProfile();
      return ok(undefined);
    },
    dispose: async () => {
      if (state === 'running' || state === 'paused') {
        if (state === 'running') cancelAnimationFrame(rafId);
        rafPending = false;
        clearFrameAdmissionWatchdog();
        clearHostInjectedInput();
        inputHandle?.();
        clearWorkerInput();
        audio.dispose();
        state = 'stopped';
        setEngineHealth('stopped');
        finishProfile();
      } else if (state !== 'stopped') {
        clearFrameAdmissionWatchdog();
        clearHostInjectedInput();
        inputHandle?.();
        clearWorkerInput();
        audio.dispose();
        state = 'stopped';
        setEngineHealth('stopped');
        finishProfile();
      }
      rejectPendingInspections(new Error('App disposed before inspection completed.'));
      return await disposeSession();
    },
    pause: () => {
      if (state !== 'running') return err(lifecycleError('app-not-started'));
      state = 'paused';
      cancelAnimationFrame(rafId);
      rafPending = false;
      return ok(undefined);
    },
    resume: () => {
      if (state !== 'paused') return err(lifecycleError('app-not-started'));
      state = 'running';
      lastTimestamp = 0;
      temporalResetPending = true;
      scheduleFrame();
      return ok(undefined);
    },
    onError: (listener) => fanout.add(listener),
    get lastError() {
      return lastError;
    },
    clearInput: clearWorkerInput,
    beginInputLease: beginWorkerInputLease,
    finishProfiler: finishWorkerProfiler,
  };
  return ok(app);
}
