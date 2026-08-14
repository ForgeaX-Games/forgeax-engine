import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { attachBrowserInputBackend, type InputBackend } from '@forgeax/engine-input';
import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { ErrorFanoutRegistry } from '../internal/error-fanout';
import type { BundlerOptions } from '../types';
import {
  APP_PHASE_CATALOG,
  type AppDispatchError,
  type CreateAppOptions,
  type ExecutionApp,
} from '../types';
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
  const bootstrapUrl = new URL(executionOptions.bootstrap, globalThis.location?.href).href;
  const startupTimeoutMs = executionOptions.startupTimeoutMs ?? 10_000;
  const frameTimeoutMs = executionOptions.frameTimeoutMs ?? 2_000;
  const started = await startEngineWorker({
    canvas: options.canvas,
    bootstrapUrl,
    ...(executionOptions.bootstrapData === undefined
      ? {}
      : { bootstrapData: executionOptions.bootstrapData }),
    ...(executionOptions.bootstrapPort === undefined
      ? {}
      : { bootstrapPort: executionOptions.bootstrapPort }),
    ...(options.bundler?.shaderManifestUrl !== undefined
      ? { shaderManifestUrl: options.bundler.shaderManifestUrl }
      : {}),
    ...(options.appOptions.time !== undefined ? { time: options.appOptions.time } : {}),
    timeoutMs: startupTimeoutMs,
    tier: options.selection.actualTier,
  });
  if (!started.ok) return started;

  const session: EngineWorkerSession = started.value;
  const profiler = options.appOptions.profiler;
  profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  const fanout = new ErrorFanoutRegistry(
    options.appOptions.silenceUnhandledErrors === undefined
      ? {}
      : { silenceUnhandledErrors: options.appOptions.silenceUnhandledErrors },
  );
  const inputHandle =
    options.appOptions.input === undefined
      ? attachBrowserInputBackend(options.canvas, {
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
  const input: InputBackend = options.appOptions.input ??
    inputHandle?.backend ?? {
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

  let report: ExecutionReport = {
    ...createExecutionReport(
      executionOptions.tier ?? 'auto',
      options.capabilities,
      options.selection,
    ),
    engine: { realm: 'worker', health: 'idle' },
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
  let frameDeadline: ReturnType<typeof setTimeout> | undefined;
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

  const setEngineHealth = (health: ExecutionReport['engine']['health']): void => {
    report = { ...report, engine: { ...report.engine, health } };
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
  };

  const terminalFault = (message: ExecutionFaultMessage): void => {
    if (frameDeadline !== undefined) {
      clearTimeout(frameDeadline);
      frameDeadline = undefined;
    }
    const error = runtimeError(message);
    lastError = error;
    state = message.partialWrite ? 'faulted' : 'stopped';
    report = {
      ...report,
      engine: { ...report.engine, health: 'faulted' },
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
      session.dispose();
    }
    finishProfile();
  };

  const scheduleFrame = (): void => {
    rafId = requestAnimationFrame((timestamp) => {
      if (state !== 'running') return;
      const deltaSeconds =
        lastTimestamp === 0 ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1_000);
      lastTimestamp = timestamp;
      const frame = ledger.issue(deltaSeconds, () => input.sample());
      if (frame === undefined) return;
      frameProfile = profiler?.activeSession();
      if (frameProfile !== undefined && profilerCaptureId !== frameProfile.captureId) {
        profilerCaptureId = frameProfile.captureId;
        profilerFrameId = 0;
      }
      profileFrameOpen = frameProfile?.beginFrame(++profilerFrameId).ok ?? false;
      hostFrameOpen = profileFrameOpen
        ? (frameProfile?.beginPhase({ source: 'app', phase: 'host-frame' }).ok ?? false)
        : false;
      session.post(frame);
      frameSentAt = performance.now();
      frameDeadline = setTimeout(() => {
        if (state !== 'running') return;
        terminalFault({
          kind: 'fault',
          worldIdentity: report.world.identity,
          source: 'runtime',
          code: 'app-execution-deadline-exceeded',
          expected: APP_EXPECTED['app-execution-deadline-exceeded'],
          hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
          detail: { phase: 'frame', timeoutMs: frameTimeoutMs },
          partialWrite: false,
          retryable: false,
        });
      }, frameTimeoutMs);
    });
  };

  session.listen((message: EngineToHostMessage) => {
    if (message.kind === 'frame-complete') {
      if (ledger.complete(message) !== 'accepted') return;
      if (frameDeadline !== undefined) clearTimeout(frameDeadline);
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
        ? (frameProfile?.beginPhase({ source: 'app', phase: 'host-audio' }).ok ?? false)
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
      audio.dispose();
      audio = createHostAudioConsumer();
      ledger = new FrameCreditLedger(message.worldIdentity);
      hostFrameMeasurements.clear();
      engineMeasurements.clear();
      kernelMeasurements.clear();
      audioMeasurements.clear();
      state = 'idle';
      report = {
        ...report,
        engine: { ...report.engine, health: 'idle' },
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
      };
      rebuildResolve?.(ok(cloneExecutionReport(report)));
      rebuildResolve = undefined;
      rebuildInFlight = undefined;
    } else if (message.kind === 'host-control') {
      if (message.command === 'set-pointer-lock-allowed') {
        input.setPointerLockAllowed?.(message.allowed);
      }
    }
  });

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
        session.post({ kind: 'rebuild', worldIdentity: report.world.identity as string });
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
    execution,
    input,
    start: () => {
      if (state === 'running') return err(lifecycleError('app-already-running'));
      if (state === 'stopped' || state === 'faulted') return err(lifecycleError('app-not-started'));
      state = 'running';
      setEngineHealth('running');
      lastTimestamp = 0;
      scheduleFrame();
      return ok(undefined);
    },
    stop: () => {
      if (state !== 'running' && state !== 'paused') return err(lifecycleError('app-not-started'));
      if (state === 'running') cancelAnimationFrame(rafId);
      state = 'stopped';
      inputHandle?.();
      audio.dispose();
      session.dispose();
      setEngineHealth('stopped');
      finishProfile();
      return ok(undefined);
    },
    pause: () => {
      if (state !== 'running') return err(lifecycleError('app-not-started'));
      state = 'paused';
      cancelAnimationFrame(rafId);
      return ok(undefined);
    },
    resume: () => {
      if (state !== 'paused') return err(lifecycleError('app-not-started'));
      state = 'running';
      lastTimestamp = 0;
      scheduleFrame();
      return ok(undefined);
    },
    onError: (listener) => fanout.add(listener),
    get lastError() {
      return lastError;
    },
  };
  return ok(app);
}
