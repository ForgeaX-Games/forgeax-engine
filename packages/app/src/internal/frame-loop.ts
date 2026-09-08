import type { World } from '@forgeax/engine-ecs';
import type { ProfileFrameToken, Profiler, RecorderSession } from '@forgeax/engine-profiler';
import type { RenderError, Renderer, RenderWorldLease } from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';

import type { AppErrorCode, AppErrorDetailFor } from '../errors';
import { AppError } from '../errors';
import { APP_PHASE_CATALOG } from '../types';

export type FrameState = 'idle' | 'running' | 'paused' | 'stopped';

export interface FrameLoopOptions {
  readonly world: World;
  readonly renderer: Renderer;
  readonly onError?: (e: AppError | RenderError) => void;
  /** Optional dev-only RHI recorder hook; called once after each frame draw. */
  readonly debugRhi?: { onFrameEnd(): void };
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
  /** Run one complete update/draw frame through this loop while paused. */
  stepFrame(deltaSeconds: number): Result<void, AppError | RenderError>;
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
    return session.beginPhase('app', phase).ok;
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
  fireError: ((e: AppError | RenderError) => void) | undefined,
): boolean {
  if (!result.ok && fireError !== undefined) {
    fireError(makeWorldUpdateError(result.error));
  }
  return result.ok;
}

function updateInjectedWorlds(
  worlds: readonly World[],
  ownWorld: World,
  deltaSeconds: number,
  fireError: ((e: AppError | RenderError) => void) | undefined,
  attachedWorlds: ReadonlySet<World>,
  updatedWorlds: Set<World>,
): void {
  for (const injectedWorld of worlds) {
    if (
      injectedWorld === ownWorld ||
      updatedWorlds.has(injectedWorld) ||
      !attachedWorlds.has(injectedWorld)
    ) {
      continue;
    }
    try {
      if (fireWorldUpdateResult(injectedWorld.update(deltaSeconds), fireError)) {
        updatedWorlds.add(injectedWorld);
      }
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
  const phaseCatalogRegistration = opts.profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  let releasePhaseCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  let drawSource = opts.drawSource;
  const now = resolveNow(opts);
  const raf = resolveRaf(opts);
  const caf = resolveCaf(opts);

  let state: FrameState = 'idle';
  let lastTimestamp = 0;
  let pendingFrameId = 0;
  let profilerFrameId = 0;
  let profilerCaptureId: string | undefined;
  const leases = new Map<World, RenderWorldLease>();

  function attachPrimary(fireError: (e: AppError | RenderError) => void): void {
    if (leases.has(world)) return;
    try {
      const result = renderer.attach(world);
      if (result.ok) leases.set(world, result.value);
      else fireError(result.error);
    } catch (cause: unknown) {
      fireError(makeWorldUpdateError(cause));
    }
  }

  function syncInjectedAttachments(
    worlds: readonly World[] | undefined,
    fireError?: (e: AppError | RenderError) => void,
  ): ReadonlySet<World> | undefined {
    if (worlds === undefined) {
      for (const [attached, lease] of leases) {
        if (attached !== world) {
          lease.dispose();
          leases.delete(attached);
        }
      }
      return undefined;
    }

    const next = new Set<World>();
    for (const candidate of worlds) {
      if (candidate === world || next.has(candidate)) continue;
      if (leases.has(candidate)) {
        next.add(candidate);
        continue;
      }
      try {
        const result = renderer.attach(candidate);
        if (result.ok) {
          leases.set(candidate, result.value);
          next.add(candidate);
        } else fireError?.(result.error);
      } catch (cause: unknown) {
        fireError?.(makeWorldUpdateError(cause));
      }
    }
    for (const [attached, lease] of leases) {
      if (attached !== world && !next.has(attached)) {
        lease.dispose();
        leases.delete(attached);
      }
    }
    return next;
  }

  function releaseInjectedAttachments(): void {
    syncInjectedAttachments(undefined);
  }

  function releaseAttachments(): void {
    releaseInjectedAttachments();
    const lease = leases.get(world);
    if (lease !== undefined) {
      lease.dispose();
      leases.delete(world);
    }
  }

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

  function runFrame(deltaSeconds: number): Result<void, AppError | RenderError> {
    const session = opts.profiler?.activeSession();
    let profileFrame: ProfileFrameToken | undefined;
    let frameError: AppError | RenderError | undefined;
    let primaryUpdated = false;
    const reportError = (error: AppError | RenderError): void => {
      frameError ??= error;
      opts.onError?.(error);
    };
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
      attachPrimary(reportError);

      runProfiledPhase(session, 'world-update-primary', () => {
        try {
          if (fireWorldUpdateResult(world.update(deltaSeconds), reportError)) {
            primaryUpdated = true;
          }
        } catch (cause: unknown) {
          reportError(makeWorldUpdateError(cause));
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
          reportError(makeWorldUpdateError(cause));
        }
      });

      const attachedInjectedWorlds = syncInjectedAttachments(injected?.worlds, reportError);
      const updatedWorlds = injected === undefined ? undefined : new Set<World>();
      if (updatedWorlds !== undefined && primaryUpdated && leases.has(world)) {
        updatedWorlds.add(world);
      }

      runProfiledPhase(session, 'world-update-injected', () => {
        if (
          injected !== undefined &&
          attachedInjectedWorlds !== undefined &&
          updatedWorlds !== undefined
        ) {
          updateInjectedWorlds(
            injected.worlds,
            world,
            deltaSeconds,
            reportError,
            attachedInjectedWorlds,
            updatedWorlds,
          );
        }
      });

      runProfiledPhase(session, 'renderer-draw', () => {
        try {
          let drawResult: ReturnType<Renderer['draw']>;
          if (injected === undefined) {
            const primaryLease = leases.get(world);
            if (!primaryUpdated || primaryLease === undefined) return;
            drawResult = renderer.draw({
              leases: [primaryLease],
              camera: { lease: primaryLease },
              environment: { lease: primaryLease },
              ...(profileFrame === undefined ? {} : { profileFrame }),
            });
          } else {
            if (updatedWorlds === undefined) return;
            const readyEntries = injected.worlds
              .filter((candidate) => updatedWorlds.has(candidate))
              .map((candidate) => ({ candidate, lease: leases.get(candidate) }))
              .filter(
                (entry): entry is { candidate: World; lease: RenderWorldLease } =>
                  entry.lease !== undefined,
              );
            const readyLeases = readyEntries.map((entry) => entry.lease);
            const cameraWorld = injected.worlds[injected.cameraOwner];
            const environmentWorld = injected.worlds[injected.resourceOwner];
            if (cameraWorld === undefined || environmentWorld === undefined) return;
            const cameraLease = leases.get(cameraWorld);
            const environmentLease = leases.get(environmentWorld);
            if (
              readyLeases.length === 0 ||
              cameraLease === undefined ||
              environmentLease === undefined
            )
              return;
            drawResult = renderer.draw({
              leases: readyLeases,
              camera: { lease: cameraLease },
              environment: { lease: environmentLease },
              ...(profileFrame === undefined ? {} : { profileFrame }),
            });
          }
          if (drawResult !== undefined) {
            const result = drawResult as { ok: boolean; error?: RenderError };
            if (!result.ok && result.error !== undefined) {
              reportError(result.error);
            }
          }
        } catch (cause: unknown) {
          reportError(makeWorldUpdateError(cause));
        }
      });
    });
    endFrame(session);
    try {
      opts.debugRhi?.onFrameEnd();
    } catch {
      // Debug capture is an observational bridge. A recorder failure must not
      // change the App frame result or make the host loop stop.
    }
    return frameError === undefined ? ok(undefined) : err(frameError);
  }

  function tick(): void {
    if (state !== 'running') return;

    // Device loss is a renderer-owned degraded interval, not an application
    // stop. Keep the rAF heartbeat alive while the host performs the explicit
    // Renderer.recover() rebuild, but freeze simulation so recovery does not
    // advance the World against frames that cannot be submitted. The next
    // tick observes `alive` and resumes the normal update/draw sequence.
    const timestamp = now();
    const deltaSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;
    runFrame(deltaSeconds);
    pendingFrameId = raf(tick);
  }

  function releaseProfiler(): void {
    finishProfilerCapture(opts.profiler);
    releasePhaseCatalog?.();
    releasePhaseCatalog = undefined;
  }

  return {
    setDrawSource(nextDrawSource): void {
      if (drawSource !== nextDrawSource) syncInjectedAttachments(undefined);
      drawSource = nextDrawSource;
    },
    stepFrame(deltaSeconds): Result<void, AppError | RenderError> {
      const reason =
        state !== 'paused'
          ? 'state'
          : !Number.isFinite(deltaSeconds) || deltaSeconds < 0
            ? 'delta'
            : undefined;
      if (reason !== undefined) {
        return err(
          makeAppError(
            'app-frame-step-invalid',
            'state is "paused" and deltaSeconds is finite and non-negative',
            'pause the App and pass a finite non-negative delta before retrying',
            { state, deltaSeconds, reason },
          ),
        );
      }
      return runFrame(deltaSeconds);
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
      state = 'stopped';
      releaseAttachments();
      releaseProfiler();
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
      releaseAttachments();
      releaseProfiler();
      state = 'stopped';
    },
  };
}
