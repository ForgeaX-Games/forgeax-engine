import { err, ok, type Result, type World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { RhiError } from '@forgeax/engine-rhi/errors';

import type { AppErrorCode, AppErrorDetailFor } from '../errors';
import { AppError } from '../errors';
import type { FramePhase, FramePhaseObserver } from '../types';

export type FrameState = 'idle' | 'running' | 'paused' | 'stopped';

export interface FrameLoopOptions {
  readonly world: World;
  readonly renderer: Renderer;
  readonly onError?: (e: AppError | RhiError) => void;
  readonly now?: () => number;
  readonly raf?: (cb: (t: number) => void) => number;
  readonly caf?: (id: number) => void;
  readonly framePhaseObserver?: FramePhaseObserver;
  readonly drawSource?: () =>
    | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
    | undefined;
}

export interface FrameLoopHandle {
  start(): Result<void, AppError>;
  stop(): Result<void, AppError>;
  pause(): Result<void, AppError>;
  resume(): Result<void, AppError>;
  getState(): FrameState;
  setStopped(): void;
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
  const now = resolveNow(opts);
  const raf = resolveRaf(opts);
  const caf = resolveCaf(opts);

  let state: FrameState = 'idle';
  let lastTimestamp = 0;
  let pendingFrameId = 0;
  let frameSeq = 0;

  function notifyPhase(
    seq: number,
    phase: FramePhase,
    boundary: 'begin' | 'end',
    worldCount?: number,
  ): void {
    const observer = opts.framePhaseObserver;
    if (observer === undefined) return;
    try {
      observer.onEvent({
        frameSeq: seq,
        phase,
        boundary,
        ...(worldCount === undefined ? {} : { worldCount }),
      });
    } catch {
      // Diagnostics must never change the frame-loop's production behavior.
    }
  }

  function runPhase<T>(seq: number, phase: FramePhase, action: () => T, worldCount?: number): T {
    if (opts.framePhaseObserver === undefined) return action();
    notifyPhase(seq, phase, 'begin', worldCount);
    try {
      return action();
    } finally {
      notifyPhase(seq, phase, 'end', worldCount);
    }
  }

  function tick(): void {
    if (state !== 'running') return;

    const seq = ++frameSeq;
    runPhase(seq, 'frame-total', () => {
      const timestamp = now();
      const deltaSeconds = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      const fireError = opts.onError;

      runPhase(
        seq,
        'world-update-primary',
        () => {
          try {
            fireWorldUpdateResult(world.update(deltaSeconds), fireError);
          } catch (cause: unknown) {
            if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
          }
        },
        1,
      );

      let injected:
        | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
        | undefined;
      runPhase(seq, 'draw-source', () => {
        if (opts.drawSource === undefined) return;
        try {
          injected = opts.drawSource();
        } catch (cause: unknown) {
          if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
        }
      });

      const injectedWorldCount =
        injected === undefined
          ? 0
          : injected.worlds.filter((injectedWorld) => injectedWorld !== world).length;
      runPhase(
        seq,
        'world-update-injected',
        () => {
          if (injected !== undefined) {
            updateInjectedWorlds(injected.worlds, world, deltaSeconds, fireError);
          }
        },
        injectedWorldCount,
      );

      runPhase(seq, 'renderer-draw', () => {
        try {
          const drawResult =
            injected !== undefined
              ? renderer.draw([...injected.worlds], {
                  cameraOwner: injected.cameraOwner,
                  resourceOwner: injected.resourceOwner,
                })
              : renderer.draw([world], { owner: 0 });
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
    pendingFrameId = raf(tick);
  }

  return {
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
