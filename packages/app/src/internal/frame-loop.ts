import { err, ok, type Result, type World } from '@forgeax/engine-ecs';
import type { ProfileFrameToken, Profiler, RecorderSession } from '@forgeax/engine-profiler';
import type { Renderer } from '@forgeax/engine-render';
import type { RhiError } from '@forgeax/engine-rhi/errors';

import type { AppErrorCode, AppErrorDetailFor } from '../errors';
import { AppError } from '../errors';
import { APP_PHASE_CATALOG } from '../types';

export type FrameState = 'idle' | 'running' | 'paused' | 'stopped';

export interface FrameLoopOptions {
  readonly world: World;
  readonly renderer: Renderer;
  readonly onError?: (e: AppError | RhiError) => void;
  readonly now?: () => number;
  readonly raf?: (cb: (t: number) => void) => number;
  readonly caf?: (id: number) => void;
  readonly profiler?: Profiler;
  readonly drawSource?: () =>
    | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
    | undefined;
}

export interface FrameLoopHandle {
  start(): Result<void, AppError>;
  stop(): Result<void, AppError>;
  pause(): Result<void, AppError>;
  resume(): Result<void, AppError>;
  /** Replace the per-frame world routing pull without replacing the loop. */
  setDrawSource(drawSource: FrameLoopOptions['drawSource']): void;
  getState(): FrameState;
  setStopped(): void;
}

function beginFrame(session: RecorderSession | undefined, frameId: number): boolean {
  if (session === undefined) return false;
  try {
    return session.beginFrame(frameId).ok;
  } catch {
    return false;
  }
}

function beginPhase(session: RecorderSession | undefined, phase: string): boolean {
  if (session === undefined) return false;
  try {
    return session.beginPhase({ source: 'app', phase }).ok;
  } catch {
    return false;
  }
}

function endPhase(session: RecorderSession | undefined): void {
  if (session === undefined) return;
  try {
    session.endPhase();
  } catch {
    // Profiler failures never alter the host loop.
  }
}

function endFrame(session: RecorderSession | undefined): void {
  if (session === undefined) return;
  try {
    session.endFrame();
  } catch {
    // Profiler failures never alter the host loop.
  }
}

function finishProfilerCapture(profiler: Profiler | undefined): void {
  const session = profiler?.activeSession();
  if (session === undefined) return;
  try {
    session.finish();
  } catch {
    // Profiler failures never alter the host stop transition.
  }
}

function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

function makeWorldUpdateError(cause: unknown): AppError {
  return makeAppError(
    'app-system-update-failed',
    'world.update(deltaSeconds) completes successfully',
    'check detail.cause for the original structured ECS error',
    { cause },
  );
}

function fireWorldUpdateResult(
  result: ReturnType<World['update']>,
  fireError: ((e: AppError | RhiError) => void) | undefined,
): void {
  if (!result.ok && fireError !== undefined) {
    fireError(makeWorldUpdateError(result.error));
  }
}

function updateInjectedWorlds(
  worlds: readonly World[],
  ownWorld: World,
  deltaSeconds: number,
  fireError: ((e: AppError | RhiError) => void) | undefined,
): void {
  for (const injectedWorld of worlds) {
    if (injectedWorld === ownWorld) continue;
    try {
      fireWorldUpdateResult(injectedWorld.update(deltaSeconds), fireError);
    } catch (cause: unknown) {
      if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
    }
  }
}

function resolveNow(opts: FrameLoopOptions): () => number {
  if (opts.now !== undefined) return opts.now;
  return () => {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const fn = perf?.now;
    return typeof fn === 'function' ? fn.call(perf) : Date.now();
  };
}

function resolveRaf(opts: FrameLoopOptions): (cb: (t: number) => void) => number {
  if (opts.raf !== undefined) return opts.raf;
  const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number };
  return typeof g.requestAnimationFrame === 'function'
    ? g.requestAnimationFrame.bind(globalThis)
    : () => 0;
}

function resolveCaf(opts: FrameLoopOptions): (id: number) => void {
  if (opts.caf !== undefined) return opts.caf;
  const g = globalThis as { cancelAnimationFrame?: (id: number) => void };
  return typeof g.cancelAnimationFrame === 'function'
    ? g.cancelAnimationFrame.bind(globalThis)
    : () => {};
}

export function createFrameLoop(opts: FrameLoopOptions): FrameLoopHandle {
  const { world, renderer } = opts;
  opts.profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  let drawSource = opts.drawSource;
  const now = resolveNow(opts);
  const raf = resolveRaf(opts);
  const caf = resolveCaf(opts);

  let state: FrameState = 'idle';
  let lastTimestamp = 0;
  let pendingFrameId = 0;
  let profilerFrameId = 0;
  let profilerCaptureId: string | undefined;

  function runProfiledPhase<T>(
    session: RecorderSession | undefined,
    phase: string,
    action: () => T,
  ): T {
    const opened = beginPhase(session, phase);
    try {
      return action();
    } finally {
      if (opened) endPhase(session);
    }
  }

  function tick(): void {
    if (state !== 'running') return;

    // Device loss is a renderer-owned degraded interval, not an application
    // stop. Keep the rAF heartbeat alive while the host performs the explicit
    // Renderer.recover() rebuild, but freeze simulation so recovery does not
    // advance the World against frames that cannot be submitted. The next
    // tick observes `alive` and resumes the normal update/draw sequence.
    if (renderer.health?.().reason === 'device-lost') {
      pendingFrameId = raf(tick);
      return;
    }

    const session = opts.profiler?.activeSession();
    let profileFrame: ProfileFrameToken | undefined;
    if (session !== undefined) {
      if (profilerCaptureId !== session.captureId) {
        profilerCaptureId = session.captureId;
        profilerFrameId = 0;
      }
      const frameId = ++profilerFrameId;
      if (beginFrame(session, frameId)) {
        profileFrame = { captureId: session.captureId, frameId };
      }
    }

    runProfiledPhase(session, 'frame-total', () => {
      const timestamp = now();
      const deltaSeconds = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      const fireError = opts.onError;

      runProfiledPhase(session, 'world-update-primary', () => {
        try {
          fireWorldUpdateResult(world.update(deltaSeconds), fireError);
        } catch (cause: unknown) {
          if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
        }
      });

      let injected:
        | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
        | undefined;
      runProfiledPhase(session, 'draw-source', () => {
        if (drawSource === undefined) return;
        try {
          injected = drawSource();
        } catch (cause: unknown) {
          if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
        }
      });

      runProfiledPhase(session, 'world-update-injected', () => {
        if (injected !== undefined) {
          updateInjectedWorlds(injected.worlds, world, deltaSeconds, fireError);
        }
      });

      runProfiledPhase(session, 'renderer-draw', () => {
        try {
          const profileOptions = profileFrame === undefined ? {} : { profileFrame };
          const drawResult =
            injected !== undefined
              ? renderer.draw([...injected.worlds], {
                  cameraOwner: injected.cameraOwner,
                  resourceOwner: injected.resourceOwner,
                  ...profileOptions,
                })
              : renderer.draw([world], { owner: 0, ...profileOptions });
          if (drawResult !== undefined) {
            const result = drawResult as { ok: boolean; error?: RhiError };
            if (!result.ok && result.error !== undefined && fireError !== undefined) {
              fireError(result.error);
            }
          }
        } catch (cause: unknown) {
          if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
        }
      });
    });
    endFrame(session);
    pendingFrameId = raf(tick);
  }

  return {
    setDrawSource(nextDrawSource): void {
      drawSource = nextDrawSource;
    },
    start(): Result<void, AppError> {
      if (state === 'running') {
        return err(
          makeAppError(
            'app-already-running',
            'state must be "idle" or "paused" to start',
            'call stop() first or check getState() before retrying',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state',
            'create a new App via createApp({...}); the existing handle is dead',
            {},
          ),
        );
      }
      lastTimestamp = now();
      state = 'running';
      pendingFrameId = raf(tick);
      return ok(undefined);
    },

    stop(): Result<void, AppError> {
      if (state === 'idle') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" to stop',
            'check getState() before calling stop(); idle handles cannot stop',
            {},
          ),
        );
      }
      if (state === 'paused') {
        return err(
          makeAppError(
            'app-paused-while-stop',
            'state must be "running" to stop; paused handles must resume() first',
            'call resume() then stop(), or treat stop-while-paused as a host bug',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state',
            'discard this handle and create a new App',
            {},
          ),
        );
      }
      caf(pendingFrameId);
      pendingFrameId = 0;
      state = 'idle';
      finishProfilerCapture(opts.profiler);
      return ok(undefined);
    },

    pause(): Result<void, AppError> {
      if (state === 'paused') return ok(undefined);
      if (state !== 'running') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" or "paused" to pause',
            'call start() first; idle handles cannot pause',
            {},
          ),
        );
      }
      caf(pendingFrameId);
      pendingFrameId = 0;
      state = 'paused';
      return ok(undefined);
    },

    resume(): Result<void, AppError> {
      if (state === 'idle' || state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "paused" to resume',
            'call start() first to leave idle; resume() expects an active handle',
            {},
          ),
        );
      }
      if (state === 'running') return ok(undefined);
      lastTimestamp = now();
      state = 'running';
      pendingFrameId = raf(tick);
      return ok(undefined);
    },

    getState(): FrameState {
      return state;
    },

    setStopped(): void {
      if (pendingFrameId !== 0) {
        caf(pendingFrameId);
        pendingFrameId = 0;
      }
      state = 'stopped';
    },
  };
}
